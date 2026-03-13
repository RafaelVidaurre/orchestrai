import path from "node:path";

import type {
  CodexRuntimeEvent,
  Issue,
  LinearProjectInfo,
  LinearRateLimits,
  LoadedWorkflow,
  OperatorEvent,
  RetryEntry,
  RunningEntry,
  RuntimeTotals,
  ServiceConfig,
  StatusSnapshot,
  WorkerActivityEvent,
  WorkerCancelReason,
  WorkerOutcome
} from "./domain";
import { validateDispatchConfig } from "./config";
import { Logger } from "./logger";
import { IssueWorker } from "./runner";
import { createTrackerClient } from "./tracker";
import {
  computeRetryDelayMs,
  isActiveState,
  isTerminalState,
  normalizeState,
  sortIssuesForDispatch
} from "./utils";
import { WorkflowManager } from "./workflow";
import { WorkspaceManager } from "./workspace";

export class Orchestrator {
  private static readonly MAX_RECENT_EVENTS = 80;

  private readonly logger: Logger;
  private readonly workflowManager: WorkflowManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly codexTotals: RuntimeTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0
  };
  private codexRateLimits: unknown = null;
  private linearRateLimits: LinearRateLimits | null = null;
  private linearProject: LinearProjectInfo | null = null;
  private linearProjectLookupSlug: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private currentWorkflow: LoadedWorkflow | null = null;
  private readonly subscribers = new Set<(snapshot: StatusSnapshot) => void>();
  private readonly recentEvents: OperatorEvent[] = [];

  constructor(
    workflowPath: string,
    logger = new Logger(),
    env: NodeJS.ProcessEnv = process.env
  ) {
    this.logger = logger.child({ component: "orchestrator" });
    this.workflowManager = new WorkflowManager(path.resolve(workflowPath), this.logger.child({ component: "workflow" }), env);
    this.workspaceManager = new WorkspaceManager(this.logger.child({ component: "workspace" }));
  }

  async start(): Promise<void> {
    await this.workflowManager.start();
    const workflow = await this.refreshWorkflow();
    validateDispatchConfig(workflow.config);
    await this.ensureProjectMetadata(workflow.config);
    await this.startupTerminalWorkspaceCleanup(workflow);
    this.recordEvent("info", "orchestrator started", {
      workflow_path: workflow.config.workflowPath,
      poll_interval_ms: workflow.config.polling.intervalMs,
      max_concurrent_agents: workflow.config.agent.maxConcurrentAgents
    });
    this.publishSnapshot();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.workflowManager.close();

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    for (const retryEntry of this.retryAttempts.values()) {
      clearTimeout(retryEntry.timerHandle);
    }
    this.retryAttempts.clear();

    const workerResults = [...this.running.values()].map((entry) => {
      entry.worker.cancel("service_stopping");
      return entry.worker.result.catch(() => undefined);
    });
    await Promise.all(workerResults);
    this.recordEvent("info", "orchestrator stopped");
    this.publishSnapshot();
  }

  async getCurrentWorkflow(): Promise<LoadedWorkflow> {
    return this.refreshWorkflow();
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    this.subscribers.add(listener);
    if (this.currentWorkflow) {
      listener(this.snapshot());
    }
    return () => {
      this.subscribers.delete(listener);
    };
  }

  snapshot(): StatusSnapshot {
    if (!this.currentWorkflow) {
      throw new Error("Orchestrator snapshot requested before workflow is loaded");
    }

    const workflow = this.currentWorkflow;
    const project = this.currentProjectInfo();

    return {
      updated_at: new Date().toISOString(),
      project_count: 1,
      running_count: this.running.size,
      retry_count: this.retryAttempts.size,
      completed_count: this.completed.size,
      claimed_count: this.claimed.size,
      projects: [
        {
          workflow_path: workflow.config.workflowPath,
          poll_interval_ms: workflow.config.polling.intervalMs,
          max_concurrent_agents: workflow.config.agent.maxConcurrentAgents,
          running_count: this.running.size,
          retry_count: this.retryAttempts.size,
          completed_count: this.completed.size,
          claimed_count: this.claimed.size,
          linear_project: project,
          linear_rate_limits: this.linearRateLimits,
          codex_totals: { ...this.codexTotals },
          codex_rate_limits: this.codexRateLimits,
          updated_at: new Date().toISOString()
        }
      ],
      running: [...this.running.values()].map((entry) => ({
        workflow_path: workflow.config.workflowPath,
        project_slug: project.slug,
        project_name: project.name,
        project_url: project.url,
        issue_id: entry.issue.id,
        identifier: entry.identifier,
        title: entry.issue.title,
        state: entry.issue.state,
        priority: entry.issue.priority,
        attempt: entry.retryAttempt,
        session_id: entry.sessionId,
        thread_id: entry.threadId,
        turn_id: entry.turnId,
        codex_app_server_pid: entry.codexAppServerPid,
        phase: entry.phase,
        activity: entry.activity,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        last_timestamp_ms: entry.lastCodexTimestampMs,
        started_at_ms: entry.startedAtMs,
        turn_count: entry.turnCount,
        codex_input_tokens: entry.codexInputTokens,
        codex_output_tokens: entry.codexOutputTokens,
        codex_total_tokens: entry.codexTotalTokens,
        issue_url: entry.issue.url
      })),
      retries: [...this.retryAttempts.values()].map((entry) => ({
        workflow_path: workflow.config.workflowPath,
        project_slug: project.slug,
        project_name: project.name,
        project_url: project.url,
        issue_id: entry.issueId,
        identifier: entry.identifier,
        title: entry.title,
        attempt: entry.attempt,
        due_at_ms: entry.dueAtMs,
        error: entry.error
      })),
      codex_totals: { ...this.codexTotals },
      recent_events: [...this.recentEvents]
    };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }

    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let workflow: LoadedWorkflow;
    try {
      workflow = await this.refreshWorkflow();
    } catch (error) {
      this.logger.errorWithCause("tick skipped because workflow could not be loaded", error);
      this.scheduleTick(30000);
      return;
    }

    await this.reconcileRunningIssues(workflow.config);

    try {
      validateDispatchConfig(workflow.config);
    } catch (error) {
      this.logger.errorWithCause("dispatch preflight validation failed", error);
      this.scheduleTick(workflow.config.polling.intervalMs);
      return;
    }

    await this.ensureProjectMetadata(workflow.config);

    try {
      const tracker = this.createTracker(workflow.config);
      const issues = await tracker.fetchCandidateIssues();
      this.logger.debug("candidate issues fetched", {
        candidate_count: issues.length,
        running_count: this.running.size,
        retry_count: this.retryAttempts.size
      });
      for (const issue of sortIssuesForDispatch(issues)) {
        if (this.availableGlobalSlots(workflow.config) <= 0) {
          break;
        }

        if (this.shouldDispatchIssue(issue, workflow.config)) {
          this.dispatchIssue(issue, null, workflow);
        }
      }
    } catch (error) {
      this.logger.errorWithCause("tracker candidate issue fetch failed", error);
    }

    this.publishSnapshot();
    this.scheduleTick(workflow.config.polling.intervalMs);
  }

  private dispatchIssue(issue: Issue, attempt: number | null, workflow: LoadedWorkflow): void {
    const worker = new IssueWorker(
      issue,
      attempt,
      workflow,
      this.logger,
      (event) => {
        this.handleCodexEvent(issue.id, event);
      },
      (event) => {
        this.handleWorkerActivity(issue.id, event);
      }
    );

    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      retryAttempt: attempt,
      startedAtMs: Date.now(),
      worker,
      sessionId: null,
      threadId: null,
      turnId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestampMs: null,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
      cancellingReason: null,
      phase: "queued",
      activity: "Waiting for worker activity"
    };

    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const retry = this.retryAttempts.get(issue.id);
    if (retry) {
      clearTimeout(retry.timerHandle);
      this.retryAttempts.delete(issue.id);
    }

    this.recordEvent("info", "issue dispatched", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_title: issue.title,
      state: issue.state,
      attempt
    });
    this.publishSnapshot();

    void worker.result.then((outcome) => {
      void this.handleWorkerExit(issue.id, outcome);
    });
  }

  private async handleWorkerExit(issueId: string, outcome: WorkerOutcome): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    this.running.delete(issueId);
    this.codexTotals.secondsRunning += Math.max(0, Math.round((Date.now() - entry.startedAtMs) / 1000));

    const workflow = await this.refreshWorkflow();

    if (this.stopping || outcome.kind === "service_stopping") {
      this.releaseClaim(issueId);
      this.publishSnapshot();
      return;
    }

    this.recordEvent(outcome.kind === "normal" ? "info" : "warn", "worker exited", {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      outcome: outcome.kind,
      error: "error" in outcome ? outcome.error : null,
      turn_count: outcome.turnCount
    });

    if (outcome.kind === "normal") {
      this.completed.add(issueId);
      if (isTerminalState(outcome.issue.state, workflow.config)) {
        await this.workspaceManager.removeWorkspace(workflow.config, outcome.issue.identifier, workflow.env);
        this.releaseClaim(issueId);
        this.publishSnapshot();
        return;
      }

      if (isActiveState(outcome.issue.state, workflow.config)) {
        this.scheduleRetry(
          issueId,
          1,
          {
            identifier: entry.identifier,
            title: entry.issue.title,
            error: null,
            continuation: true
          },
          workflow.config
        );
        return;
      }

      this.releaseClaim(issueId);
      this.publishSnapshot();
      return;
    }

    if (outcome.kind === "canceled_non_active") {
      this.releaseClaim(issueId);
      this.publishSnapshot();
      return;
    }

    if (outcome.kind === "canceled_terminal") {
      await this.workspaceManager.removeWorkspace(workflow.config, outcome.issue.identifier, workflow.env);
      this.releaseClaim(issueId);
      this.publishSnapshot();
      return;
    }

    this.scheduleRetry(
      issueId,
      nextAttemptFrom(entry),
      {
        identifier: entry.identifier,
        title: entry.issue.title,
        error: outcome.error,
        continuation: false
      },
      workflow.config
    );
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) {
      return;
    }
    this.retryAttempts.delete(issueId);

    const workflow = await this.refreshWorkflow();
    const tracker = this.createTracker(workflow.config);

    try {
      const candidates = await tracker.fetchCandidateIssues();
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (!issue) {
        this.releaseClaim(issueId);
        return;
      }

      const retryEligibility = this.evaluateDispatchEligibility(issue, workflow.config, issueId);
      if (retryEligibility === "eligible") {
        this.dispatchIssue(issue, retryEntry.attempt, workflow);
        return;
      }

      if (retryEligibility === "ineligible") {
        this.releaseClaim(issueId);
        return;
      }

      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        {
          identifier: issue.identifier,
          title: issue.title,
          error: "no available orchestrator slots",
          continuation: false
        },
        workflow.config
      );
    } catch (error) {
      this.scheduleRetry(
        issueId,
        retryEntry.attempt + 1,
        {
          identifier: retryEntry.identifier,
          title: retryEntry.title,
          error: "retry poll failed",
          continuation: false
        },
        workflow.config
      );
      this.logger.errorWithCause("retry timer failed to fetch candidate issues", error, {
        issue_id: issueId
      });
    }
  }

  private async reconcileRunningIssues(config: ServiceConfig): Promise<void> {
    this.reconcileStalledRuns(config);

    const issueIds = [...this.running.keys()].filter((issueId) => !this.running.get(issueId)?.cancellingReason);
    if (issueIds.length === 0) {
      return;
    }

    const tracker = this.createTracker(config);
    try {
      const refreshed = await tracker.fetchIssueStatesByIds(issueIds);
      const byId = new Map(refreshed.map((issue) => [issue.id, issue]));

      for (const issueId of issueIds) {
        const entry = this.running.get(issueId);
        if (!entry || entry.cancellingReason) {
          continue;
        }

        const issue = byId.get(issueId);
        if (!issue) {
          continue;
        }

        if (isTerminalState(issue.state, config)) {
          this.cancelRunningIssue(issueId, "canceled_terminal");
          continue;
        }

        if (isActiveState(issue.state, config)) {
          entry.issue = issue;
          continue;
        }

        this.cancelRunningIssue(issueId, "canceled_non_active");
      }
    } catch (error) {
      this.logger.errorWithCause("running issue reconciliation failed; leaving workers active", error);
    }
  }

  private reconcileStalledRuns(config: ServiceConfig): void {
    if (config.codex.stallTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [issueId, entry] of this.running.entries()) {
      if (entry.cancellingReason) {
        continue;
      }

      const lastSeenMs = entry.lastCodexTimestampMs ?? entry.startedAtMs;
      if (now - lastSeenMs > config.codex.stallTimeoutMs) {
        this.cancelRunningIssue(issueId, "stalled");
      }
    }
  }

  private cancelRunningIssue(issueId: string, reason: WorkerCancelReason): void {
    const entry = this.running.get(issueId);
    if (!entry || entry.cancellingReason) {
      return;
    }

    entry.cancellingReason = reason;
    entry.worker.cancel(reason);
    this.recordEvent("info", "worker cancellation requested", {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      reason
    });
    this.publishSnapshot();
  }

  private handleWorkerActivity(issueId: string, event: WorkerActivityEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    entry.phase = event.phase;
    entry.activity = event.message;
    entry.lastCodexTimestampMs = Date.parse(event.timestamp);
    this.publishSnapshot();
  }

  private handleCodexEvent(issueId: string, event: CodexRuntimeEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    if (entry.codexAppServerPid === null && event.codexAppServerPid !== null) {
      entry.codexAppServerPid = event.codexAppServerPid;
    }
    entry.lastCodexEvent = event.event;
    entry.lastCodexMessage = event.message ?? event.event;
    entry.lastCodexTimestampMs = Date.parse(event.timestamp);
    entry.activity = humanizeCodexEvent(event);
    if (event.event === "session_started") {
      entry.phase = "streaming_turn";
    }

    if (event.sessionId) {
      entry.sessionId = event.sessionId;
      entry.threadId = event.threadId ?? null;
      entry.turnId = event.turnId ?? null;
      entry.turnCount += 1;
    }

    if (event.usage) {
      const inputDelta = Math.max(0, event.usage.input_tokens - entry.lastReportedInputTokens);
      const outputDelta = Math.max(0, event.usage.output_tokens - entry.lastReportedOutputTokens);
      const totalDelta = Math.max(0, event.usage.total_tokens - entry.lastReportedTotalTokens);
      this.codexTotals.inputTokens += inputDelta;
      this.codexTotals.outputTokens += outputDelta;
      this.codexTotals.totalTokens += totalDelta;
      entry.codexInputTokens = event.usage.input_tokens;
      entry.codexOutputTokens = event.usage.output_tokens;
      entry.codexTotalTokens = event.usage.total_tokens;
      entry.lastReportedInputTokens = event.usage.input_tokens;
      entry.lastReportedOutputTokens = event.usage.output_tokens;
      entry.lastReportedTotalTokens = event.usage.total_tokens;
    }

    if (event.rateLimits !== undefined) {
      this.codexRateLimits = event.rateLimits;
    }

    if (shouldRecordCodexEvent(event)) {
      this.recordEvent(
        event.event === "turn_failed" || event.event === "turn_input_required" ? "warn" : "info",
        `codex ${event.event}`,
        {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          message: event.message ?? null,
          session_id: event.sessionId ?? null
        }
      );
    }

    this.publishSnapshot();
  }

  private shouldDispatchIssue(issue: Issue, config: ServiceConfig): boolean {
    return this.evaluateDispatchEligibility(issue, config) === "eligible";
  }

  private evaluateDispatchEligibility(
    issue: Issue,
    config: ServiceConfig,
    ignoreClaimedIssueId?: string
  ): "eligible" | "blocked" | "ineligible" {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return "ineligible";
    }

    if (!isActiveState(issue.state, config) || isTerminalState(issue.state, config)) {
      return "ineligible";
    }

    if (this.running.has(issue.id)) {
      return "blocked";
    }

    if (this.claimed.has(issue.id) && ignoreClaimedIssueId !== issue.id) {
      return "blocked";
    }

    if (normalizeState(issue.state) === "todo") {
      const hasNonTerminalBlocker = issue.blocked_by.some((blocker) => blocker.state && !isTerminalState(blocker.state, config));
      if (hasNonTerminalBlocker) {
        return "ineligible";
      }
    }

    if (this.availableGlobalSlots(config) <= 0) {
      return "blocked";
    }

    const stateLimit = config.agent.maxConcurrentAgentsByState[normalizeState(issue.state)];
    if (stateLimit && this.runningCountForState(issue.state) >= stateLimit) {
      return "blocked";
    }

    return "eligible";
  }

  private availableGlobalSlots(config: ServiceConfig): number {
    return Math.max(config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private runningCountForState(state: string): number {
    const normalized = normalizeState(state);
    let count = 0;
    for (const entry of this.running.values()) {
      if (normalizeState(entry.issue.state) === normalized) {
        count += 1;
      }
    }

    return count;
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    params: { identifier: string; title: string; error: string | null; continuation: boolean },
    config: ServiceConfig
  ): void {
    const existing = this.retryAttempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timerHandle);
    }

    const delayMs = computeRetryDelayMs(attempt, config.agent.maxRetryBackoffMs, params.continuation);
    const timerHandle = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);

    this.retryAttempts.set(issueId, {
      issueId,
      identifier: params.identifier,
      title: params.title,
      attempt,
      dueAtMs: Date.now() + delayMs,
      timerHandle,
      error: params.error
    });
    this.claimed.add(issueId);
    this.recordEvent("info", "retry scheduled", {
      issue_id: issueId,
      issue_identifier: params.identifier,
      attempt,
      delay_ms: delayMs,
      error: params.error,
      continuation: params.continuation
    });
    this.publishSnapshot();
  }

  private releaseClaim(issueId: string): void {
    const retry = this.retryAttempts.get(issueId);
    if (retry) {
      clearTimeout(retry.timerHandle);
      this.retryAttempts.delete(issueId);
    }

    this.claimed.delete(issueId);
    this.publishSnapshot();
  }

  private async startupTerminalWorkspaceCleanup(workflow: LoadedWorkflow): Promise<void> {
    const tracker = this.createTracker(workflow.config);
    try {
      const terminalIssues = await tracker.fetchIssuesByStates(workflow.config.tracker.terminalStates);
      for (const issue of terminalIssues) {
        await this.workspaceManager.removeWorkspace(workflow.config, issue.identifier, workflow.env);
      }
      this.recordEvent("info", "startup terminal workspace cleanup complete", {
        cleaned_issue_count: terminalIssues.length
      });
    } catch (error) {
      this.logger.errorWithCause("startup terminal workspace cleanup failed", error);
    }
  }

  private async refreshWorkflow(): Promise<LoadedWorkflow> {
    const workflow = await this.workflowManager.getCurrent();
    if (!this.currentWorkflow || this.currentWorkflow.config.tracker.projectSlug !== workflow.config.tracker.projectSlug) {
      this.linearProject = null;
      this.linearProjectLookupSlug = null;
    }
    this.currentWorkflow = workflow;
    return workflow;
  }

  private createTracker(config: ServiceConfig) {
    return createTrackerClient(config, this.logger, {
      onLinearRateLimits: (limits) => {
        this.linearRateLimits = limits;
      }
    });
  }

  private async ensureProjectMetadata(config: ServiceConfig): Promise<void> {
    if (this.linearProjectLookupSlug === config.tracker.projectSlug) {
      return;
    }

    this.linearProjectLookupSlug = config.tracker.projectSlug;

    try {
      const tracker = this.createTracker(config);
      const project = await tracker.fetchProjectMetadata();
      if (project) {
        this.linearProject = project;
      }
    } catch (error) {
      this.logger.warn("linear project metadata lookup failed; dashboard will use configured slug only", {
        project_slug: config.tracker.projectSlug,
        error_message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.publishSnapshot();
    }
  }

  private currentProjectInfo(): LinearProjectInfo {
    if (!this.currentWorkflow) {
      throw new Error("Project info requested before workflow is loaded");
    }

    return this.linearProject ?? {
      slug: this.currentWorkflow.config.tracker.projectSlug,
      name: null,
      url: null,
      updated_at: null
    };
  }

  private publishSnapshot(): void {
    if (!this.currentWorkflow) {
      return;
    }

    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }

  private recordEvent(level: OperatorEvent["level"], message: string, fields?: Record<string, unknown>): void {
    this.recentEvents.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      issueId: asOptionalString(fields?.issue_id),
      issueIdentifier: asOptionalString(fields?.issue_identifier),
      fields
    });
    this.recentEvents.splice(Orchestrator.MAX_RECENT_EVENTS);

    const logFields = fields ?? {};
    switch (level) {
      case "debug":
        this.logger.debug(message, logFields);
        break;
      case "info":
        this.logger.info(message, logFields);
        break;
      case "warn":
        this.logger.warn(message, logFields);
        break;
      case "error":
        this.logger.error(message, logFields);
        break;
    }
  }
}

function nextAttemptFrom(entry: RunningEntry): number {
  return entry.retryAttempt === null ? 1 : entry.retryAttempt + 1;
}

function shouldRecordCodexEvent(event: CodexRuntimeEvent): boolean {
  return [
    "session_started",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_input_required",
    "startup_failed",
    "unsupported_tool_call"
  ].includes(event.event);
}

function humanizeCodexEvent(event: CodexRuntimeEvent): string {
  if (event.message) {
    return event.message;
  }

  switch (event.event) {
    case "session_started":
      return "Codex session started";
    case "turn_completed":
      return "Codex turn completed";
    case "turn_failed":
      return "Codex turn failed";
    case "turn_cancelled":
      return "Codex turn cancelled";
    case "turn_input_required":
      return "Codex requested input";
    case "approval_auto_approved":
      return "Auto-approved agent request";
    case "unsupported_tool_call":
      return "Unsupported tool call requested";
    default:
      return event.event;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
