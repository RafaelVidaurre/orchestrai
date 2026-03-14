import path from "node:path";

import type {
  AgentActivityEntry,
  AgentTranscriptEntry,
  AgentRuntimeEvent,
  AgentUsageSnapshot,
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
import { classifyFatalRuntimeError, type FatalRuntimeErrorInput } from "./fatal-runtime-errors";
import { ServiceError } from "./errors";
import {
  classifyHumanizedCodexMessage,
  isNarrativeTranscriptKind,
  normalizeTranscriptMessage,
  stitchTranscriptMessages,
  shouldCaptureHumanizedCodexTranscript,
  shouldRecordHumanizedCodexNotification
} from "./codex-humanize";

export class Orchestrator {
  private static readonly MAX_RECENT_EVENTS = 80;
  private static readonly MAX_AGENT_ACTIVITY = 12;
  private static readonly MAX_AGENT_TRANSCRIPT = 120;

  private readonly logger: Logger;
  private readonly workflowManager: WorkflowManager;
  private readonly workspaceManager: WorkspaceManager;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly agentTotals: RuntimeTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0
  };
  private agentRateLimits: unknown = null;
  private linearRateLimits: LinearRateLimits | null = null;
  private linearProject: LinearProjectInfo | null = null;
  private linearProjectLookupSlug: string | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private currentWorkflow: LoadedWorkflow | null = null;
  private readonly subscribers = new Set<(snapshot: StatusSnapshot) => void>();
  private readonly recentEvents: OperatorEvent[] = [];
  private readonly workflowPath: string;
  private readonly onFatalError: ((input: FatalRuntimeErrorInput) => Promise<boolean | void> | boolean | void) | null;
  private readonly onUsageDelta:
    | ((
        input: {
          workflowPath: string;
          projectSlug: string;
          displayName: string | null;
          provider: AgentRuntimeEvent["provider"];
          model: string;
          usage: AgentUsageSnapshot;
          observedAt: string;
        }
      ) => Promise<void> | void)
    | null;

  constructor(
    workflowPath: string,
    logger = new Logger(),
    env: NodeJS.ProcessEnv = process.env,
    options: {
      onFatalError?: (input: FatalRuntimeErrorInput) => Promise<boolean | void> | boolean | void;
      onUsageDelta?: (input: {
        workflowPath: string;
        projectSlug: string;
        displayName: string | null;
        provider: AgentRuntimeEvent["provider"];
        model: string;
        usage: AgentUsageSnapshot;
        observedAt: string;
      }) => Promise<void> | void;
    } = {}
  ) {
    this.workflowPath = path.resolve(workflowPath);
    this.logger = logger.child({ component: "orchestrator" });
    this.workflowManager = new WorkflowManager(this.workflowPath, this.logger.child({ component: "workflow" }), env);
    this.workspaceManager = new WorkspaceManager(this.logger.child({ component: "workspace" }));
    this.onFatalError = options.onFatalError ?? null;
    this.onUsageDelta = options.onUsageDelta ?? null;
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
          display_name: workflow.config.project.displayName,
          poll_interval_ms: workflow.config.polling.intervalMs,
          max_concurrent_agents: workflow.config.agent.maxConcurrentAgents,
          agent_provider: workflow.config.runtime.provider,
          running_count: this.running.size,
          retry_count: this.retryAttempts.size,
          completed_count: this.completed.size,
          claimed_count: this.claimed.size,
          linear_project: project,
          linear_rate_limits: this.linearRateLimits,
          agent_totals: { ...this.agentTotals },
          agent_rate_limits: this.agentRateLimits,
          updated_at: new Date().toISOString()
        }
      ],
      project_states: [
        {
          workflow_path: workflow.config.workflowPath,
          enabled: workflow.config.project.enabled,
          runtime_running: true,
          fatal_error: null,
          updated_at: new Date().toISOString()
        }
      ],
      running: [...this.running.values()].map((entry) => ({
        workflow_path: workflow.config.workflowPath,
        project_slug: project.slug,
        project_name: workflow.config.project.displayName ?? project.name,
        project_url: project.url,
        issue_id: entry.issue.id,
        identifier: entry.identifier,
        title: entry.issue.title,
        state: entry.issue.state,
        priority: entry.issue.priority,
        attempt: entry.retryAttempt,
        agent_provider: entry.agentProvider,
        agent_model: entry.agentModel,
        session_id: entry.sessionId,
        thread_id: entry.threadId,
        turn_id: entry.turnId,
        agent_process_pid: entry.agentProcessPid,
        phase: entry.phase,
        activity: entry.activity,
        last_event: entry.lastAgentEvent,
        last_message: entry.lastAgentMessage,
        last_timestamp_ms: entry.lastAgentTimestampMs,
        started_at_ms: entry.startedAtMs,
        turn_count: entry.turnCount,
        agent_input_tokens: entry.agentInputTokens,
        agent_output_tokens: entry.agentOutputTokens,
        agent_total_tokens: entry.agentTotalTokens,
        issue_url: entry.issue.url,
        recent_activity: [...entry.recentActivity],
        transcript_activity: [...entry.transcriptActivity]
      })),
      retries: [...this.retryAttempts.values()].map((entry) => ({
        workflow_path: workflow.config.workflowPath,
        project_slug: project.slug,
        project_name: workflow.config.project.displayName ?? project.name,
        project_url: project.url,
        issue_id: entry.issueId,
        identifier: entry.identifier,
        title: entry.title,
        attempt: entry.attempt,
        due_at_ms: entry.dueAtMs,
        error: entry.error
      })),
      agent_totals: { ...this.agentTotals },
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
      if (await this.reportFatalError("dispatch", error)) {
        return;
      }
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
      if (await this.reportFatalError("dispatch", error)) {
        return;
      }
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
        this.handleAgentEvent(issue.id, event);
      },
      (event) => {
        this.handleWorkerActivity(issue.id, event);
      }
    );

    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      agentProvider: workflow.config.runtime.provider,
      agentModel: workflow.config.runtime.model,
      retryAttempt: attempt,
      startedAtMs: Date.now(),
      worker,
      sessionId: null,
      threadId: null,
      turnId: null,
      agentProcessPid: null,
      lastAgentEvent: null,
      lastAgentTimestampMs: null,
      lastAgentMessage: null,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      agentTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      lastReportedCacheReadInputTokens: 0,
      lastReportedCacheCreationInputTokens: 0,
      lastReportedCostUsd: 0,
      turnCount: 0,
      cancellingReason: null,
      phase: "queued",
      activity: "Waiting for worker activity",
      recentActivity: [
        {
          timestamp: new Date().toISOString(),
          source: "system",
          phase: "queued",
          message: `Dispatched from ${issue.state}`
        }
      ],
      transcriptActivity: [
        {
          timestamp: new Date().toISOString(),
          source: "system",
          phase: "queued",
          kind: "system",
          message: `Run queued from ${issue.state}`
        }
      ]
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
    this.agentTotals.secondsRunning += Math.max(0, Math.round((Date.now() - entry.startedAtMs) / 1000));

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
      error_code: "errorCode" in outcome ? outcome.errorCode : null,
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

    if (
      await this.reportFatalError(
        "worker",
        toOutcomeError(outcome),
        {
          id: outcome.issue.id,
          identifier: outcome.issue.identifier,
          title: outcome.issue.title
        }
      )
    ) {
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
      if (
        await this.reportFatalError("retry", error, {
          id: issueId,
          identifier: retryEntry.identifier,
          title: retryEntry.title
        })
      ) {
        return;
      }
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
      await this.reportFatalError("reconcile", error);
    }
  }

  private reconcileStalledRuns(config: ServiceConfig): void {
    if (config.runtime.stallTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [issueId, entry] of this.running.entries()) {
      if (entry.cancellingReason) {
        continue;
      }

      const lastSeenMs = entry.lastAgentTimestampMs ?? entry.startedAtMs;
      if (now - lastSeenMs > config.runtime.stallTimeoutMs) {
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
    entry.lastAgentTimestampMs = Date.parse(event.timestamp);
    this.appendAgentActivity(entry, {
      timestamp: event.timestamp,
      source: "worker",
      phase: event.phase,
      message: event.message
    });
    if (shouldRecordWorkerActivity(event.phase)) {
      this.recordEvent("info", "worker activity", {
        issue_id: issueId,
        issue_identifier: entry.identifier,
        phase: event.phase,
        activity: event.message
      });
    }
    this.appendTranscriptActivity(entry, {
      timestamp: event.timestamp,
      source: "worker",
      phase: event.phase,
      kind: "status",
      message: event.message
    });
    this.publishSnapshot();
  }

  private handleAgentEvent(issueId: string, event: AgentRuntimeEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    if (entry.agentProcessPid === null && event.agentProcessPid !== null) {
      entry.agentProcessPid = event.agentProcessPid;
    }
    const renderedMessage = humanizeAgentEvent(event);
    entry.lastAgentEvent = event.event;
    entry.lastAgentMessage = renderedMessage;
    entry.lastAgentTimestampMs = Date.parse(event.timestamp);
    if (shouldSurfaceAgentEventAsPrimaryActivity(event, renderedMessage)) {
      entry.activity = renderedMessage;
    }
    if (shouldPersistAgentActivity(event)) {
      this.appendAgentActivity(entry, {
        timestamp: event.timestamp,
        source: "agent",
        phase: entry.phase,
        message: renderedMessage
      });
    }
    if (shouldPersistAgentTranscript(event)) {
      this.appendTranscriptActivity(entry, {
        timestamp: event.timestamp,
        source: "agent",
        phase: entry.phase,
        kind: classifyAgentTranscriptKind(event, renderedMessage),
        message: renderedMessage
      });
    }
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
      const cacheReadDelta = Math.max(
        0,
        (event.usage.cache_read_input_tokens ?? 0) - entry.lastReportedCacheReadInputTokens
      );
      const cacheCreationDelta = Math.max(
        0,
        (event.usage.cache_creation_input_tokens ?? 0) - entry.lastReportedCacheCreationInputTokens
      );
      const costDelta = Math.max(0, (event.usage.cost_usd ?? 0) - entry.lastReportedCostUsd);
      this.agentTotals.inputTokens += inputDelta;
      this.agentTotals.outputTokens += outputDelta;
      this.agentTotals.totalTokens += totalDelta;
      entry.agentInputTokens = event.usage.input_tokens;
      entry.agentOutputTokens = event.usage.output_tokens;
      entry.agentTotalTokens = event.usage.total_tokens;
      entry.lastReportedInputTokens = event.usage.input_tokens;
      entry.lastReportedOutputTokens = event.usage.output_tokens;
      entry.lastReportedTotalTokens = event.usage.total_tokens;
      entry.lastReportedCacheReadInputTokens = event.usage.cache_read_input_tokens ?? 0;
      entry.lastReportedCacheCreationInputTokens = event.usage.cache_creation_input_tokens ?? 0;
      entry.lastReportedCostUsd = event.usage.cost_usd ?? 0;
      if ((inputDelta > 0 || outputDelta > 0 || totalDelta > 0 || costDelta > 0) && this.onUsageDelta) {
        const projectInfo = this.currentProjectInfo();
        void Promise.resolve(
          this.onUsageDelta({
            workflowPath: this.currentWorkflow?.config.workflowPath ?? this.workflowPath,
            projectSlug: projectInfo.slug,
            displayName: this.currentWorkflow?.config.project.displayName ?? null,
            provider: entry.agentProvider,
            model: entry.agentModel,
            observedAt: event.timestamp,
            usage: {
              input_tokens: inputDelta,
              output_tokens: outputDelta,
              total_tokens: totalDelta,
              cache_read_input_tokens: cacheReadDelta || undefined,
              cache_creation_input_tokens: cacheCreationDelta || undefined,
              cost_usd: costDelta || undefined
            }
          })
        ).catch((error) => {
          this.logger.warn("usage metrics update failed", {
            workflow_path: this.workflowPath,
            issue_id: issueId,
            error_message: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }

    if (event.rateLimits !== undefined) {
      this.agentRateLimits = event.rateLimits;
    }

    if (shouldRecordAgentEvent(event)) {
      this.recordEvent(
        event.event === "turn_failed" || event.event === "turn_input_required" || event.event === "tool_call_failed" ? "warn" : "info",
        `${event.provider} ${renderedMessage}`,
        {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          message: renderedMessage,
          session_id: event.sessionId ?? null
        }
      );
    }

    this.publishSnapshot();
  }

  private appendAgentActivity(entry: RunningEntry, activity: AgentActivityEntry): void {
    const last = entry.recentActivity[0];
    if (last && last.message === activity.message && last.phase === activity.phase && last.source === activity.source) {
      entry.recentActivity[0] = activity;
      return;
    }

    entry.recentActivity.unshift(activity);
    entry.recentActivity.splice(Orchestrator.MAX_AGENT_ACTIVITY);
  }

  private appendTranscriptActivity(entry: RunningEntry, activity: AgentTranscriptEntry): void {
    const normalizedMessage = normalizeTranscriptMessage(activity.kind, activity.message);
    if (!normalizedMessage) {
      return;
    }

    const normalizedActivity: AgentTranscriptEntry = {
      ...activity,
      message: normalizedMessage
    };

    const last = entry.transcriptActivity[0];
    if (last && last.message === normalizedActivity.message && last.kind === normalizedActivity.kind && last.source === normalizedActivity.source) {
      entry.transcriptActivity[0] = normalizedActivity;
      return;
    }

    if (
      last &&
      last.source === normalizedActivity.source &&
      isNarrativeTranscriptKind(last.kind) &&
      isNarrativeTranscriptKind(normalizedActivity.kind)
    ) {
      entry.transcriptActivity[0] = {
        ...last,
        timestamp: normalizedActivity.timestamp,
        phase: normalizedActivity.phase,
        kind: "message",
        message: stitchTranscriptMessages(last.message, normalizedActivity.message)
      };
      return;
    }

    entry.transcriptActivity.unshift(normalizedActivity);
    entry.transcriptActivity.splice(Orchestrator.MAX_AGENT_TRANSCRIPT);
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
    const mergedFields = this.currentWorkflow
      ? {
          workflow_path: this.currentWorkflow.config.workflowPath,
          ...(fields ?? {})
        }
      : fields;
    this.recentEvents.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      issueId: asOptionalString(mergedFields?.issue_id),
      issueIdentifier: asOptionalString(mergedFields?.issue_identifier),
      fields: mergedFields
    });
    this.recentEvents.splice(Orchestrator.MAX_RECENT_EVENTS);

    const logFields = mergedFields ?? {};
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

  private async reportFatalError(
    stage: FatalRuntimeErrorInput["stage"],
    error: unknown,
    issue?: FatalRuntimeErrorInput["issue"]
  ): Promise<boolean> {
    const provider = this.currentWorkflow?.config.runtime.provider ?? null;
    const classified = classifyFatalRuntimeError({
      provider,
      stage,
      error,
      issue
    });
    if (!classified) {
      return false;
    }

    this.recordEvent("error", "fatal runtime error detected; pausing project", {
      workflow_path: this.currentWorkflow?.config.workflowPath ?? this.workflowPath,
      fatal_code: classified.code,
      fatal_stage: classified.stage,
      fatal_message: classified.message,
      issue_id: classified.issue_id,
      issue_identifier: classified.issue_identifier
    });
    if (!this.onFatalError) {
      return true;
    }

    await this.onFatalError({
      workflowPath: this.currentWorkflow?.config.workflowPath ?? this.workflowPath,
      provider,
      stage,
      error,
      issue
    });
    return true;
  }
}

function nextAttemptFrom(entry: RunningEntry): number {
  return entry.retryAttempt === null ? 1 : entry.retryAttempt + 1;
}

function toOutcomeError(
  outcome: Extract<WorkerOutcome, { kind: "failed" | "timed_out" | "stalled" | "canceled_non_active" | "canceled_terminal" | "service_stopping" }>
): Error {
  return outcome.errorCode
    ? new ServiceError(outcome.errorCode, outcome.error, outcome.errorDetails ?? undefined)
    : new Error(outcome.error);
}

function shouldRecordAgentEvent(event: AgentRuntimeEvent): boolean {
  if (event.event === "notification") {
    return shouldRecordHumanizedCodexNotification(event.message);
  }

  return [
    "session_started",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_input_required",
    "user_input_auto_answered",
    "tool_call_completed",
    "tool_call_failed",
    "startup_failed",
    "unsupported_tool_call"
  ].includes(event.event);
}

function shouldPersistAgentActivity(event: AgentRuntimeEvent): boolean {
  if (event.event === "notification") {
    return shouldRecordHumanizedCodexNotification(event.message);
  }

  return [
    "session_started",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_input_required",
    "user_input_auto_answered",
    "approval_auto_approved",
    "tool_call_completed",
    "tool_call_failed",
    "startup_failed",
    "unsupported_tool_call"
  ].includes(event.event);
}

function shouldPersistAgentTranscript(event: AgentRuntimeEvent): boolean {
  if (event.event === "notification") {
    return shouldCaptureHumanizedCodexTranscript(event.message);
  }

  return [
    "session_started",
    "turn_completed",
    "turn_failed",
    "turn_cancelled",
    "turn_input_required",
    "user_input_auto_answered",
    "approval_auto_approved",
    "tool_call_completed",
    "tool_call_failed",
    "startup_failed",
    "unsupported_tool_call"
  ].includes(event.event);
}

function shouldSurfaceAgentEventAsPrimaryActivity(event: AgentRuntimeEvent, renderedMessage: string): boolean {
  if (event.event === "notification") {
    return shouldRecordHumanizedCodexNotification(renderedMessage);
  }

  return true;
}

function classifyAgentTranscriptKind(
  event: AgentRuntimeEvent,
  renderedMessage: string
): AgentTranscriptEntry["kind"] {
  switch (event.event) {
    case "approval_auto_approved":
      return "approval";
    case "tool_call_completed":
    case "tool_call_failed":
    case "unsupported_tool_call":
      return "tool";
    case "notification":
      return classifyHumanizedCodexMessage(renderedMessage);
    case "startup_failed":
      return "system";
    default:
      return "status";
  }
}

function shouldRecordWorkerActivity(phase: WorkerActivityEvent["phase"]): boolean {
  return [
    "preparing_workspace",
    "running_before_run_hook",
    "launching_agent_process",
    "initializing_session",
    "streaming_turn",
    "refreshing_issue_state",
    "finishing"
  ].includes(phase);
}

function humanizeAgentEvent(event: AgentRuntimeEvent): string {
  if (event.message) {
    return event.message;
  }

  switch (event.event) {
    case "session_started":
      return `${capitalizeProvider(event.provider)} session started`;
    case "turn_completed":
      return `${capitalizeProvider(event.provider)} turn completed`;
    case "turn_failed":
      return `${capitalizeProvider(event.provider)} turn failed`;
    case "turn_cancelled":
      return `${capitalizeProvider(event.provider)} turn cancelled`;
    case "turn_input_required":
      return `${capitalizeProvider(event.provider)} requested input`;
    case "user_input_auto_answered":
      return event.message ?? "Auto-answered user-input request";
    case "approval_auto_approved":
      return "Auto-approved agent request";
    case "tool_call_completed":
    case "tool_call_failed":
      return event.message ?? event.event;
    case "unsupported_tool_call":
      return "Unsupported tool call requested";
    default:
      return event.event;
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function capitalizeProvider(provider: AgentRuntimeEvent["provider"]): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "grok":
      return "Grok";
    case "codex":
    default:
      return "Codex";
  }
}
