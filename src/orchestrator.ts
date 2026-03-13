import type { Issue, LoadedWorkflow, RetryEntry, RunningEntry, RuntimeTotals, ServiceConfig, WorkerCancelReason, WorkerOutcome } from "./domain";
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
import { WorkflowManager, resolveWorkflowPath } from "./workflow";
import { WorkspaceManager } from "./workspace";

export class Orchestrator {
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
  private tickTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(workflowPath?: string, logger = new Logger()) {
    const resolvedWorkflowPath = resolveWorkflowPath(workflowPath);
    this.logger = logger.child({ component: "orchestrator" });
    this.workflowManager = new WorkflowManager(resolvedWorkflowPath, this.logger.child({ component: "workflow" }));
    this.workspaceManager = new WorkspaceManager(this.logger.child({ component: "workspace" }));
  }

  async start(): Promise<void> {
    await this.workflowManager.start();
    const workflow = await this.workflowManager.getCurrent();
    validateDispatchConfig(workflow.config);
    await this.startupTerminalWorkspaceCleanup(workflow);
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
  }

  snapshot(): Record<string, unknown> {
    return {
      running: [...this.running.values()].map((entry) => ({
        issue_id: entry.issue.id,
        identifier: entry.identifier,
        state: entry.issue.state,
        session_id: entry.sessionId,
        thread_id: entry.threadId,
        turn_id: entry.turnId,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        last_timestamp_ms: entry.lastCodexTimestampMs,
        started_at_ms: entry.startedAtMs,
        turn_count: entry.turnCount
      })),
      retries: [...this.retryAttempts.values()].map((entry) => ({
        issue_id: entry.issueId,
        identifier: entry.identifier,
        attempt: entry.attempt,
        due_at_ms: entry.dueAtMs,
        error: entry.error
      })),
      claimed: [...this.claimed],
      completed: [...this.completed],
      codex_totals: this.codexTotals,
      codex_rate_limits: this.codexRateLimits
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
      workflow = await this.workflowManager.getCurrent();
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

    try {
      const tracker = createTrackerClient(workflow.config, this.logger);
      const issues = await tracker.fetchCandidateIssues();
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

    this.scheduleTick(workflow.config.polling.intervalMs);
  }

  private dispatchIssue(issue: Issue, attempt: number | null, workflow: LoadedWorkflow): void {
    const worker = new IssueWorker(issue, attempt, workflow, this.logger, (event) => {
      this.handleCodexEvent(issue.id, event);
    });

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
      cancellingReason: null
    };

    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const retry = this.retryAttempts.get(issue.id);
    if (retry) {
      clearTimeout(retry.timerHandle);
      this.retryAttempts.delete(issue.id);
    }

    this.logger.info("issue dispatched", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt
    });

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

    const workflow = await this.workflowManager.getCurrent();

    if (this.stopping || outcome.kind === "service_stopping") {
      this.releaseClaim(issueId);
      return;
    }

    if (outcome.kind === "normal") {
      this.completed.add(issueId);
      if (isTerminalState(outcome.issue.state, workflow.config)) {
        await this.workspaceManager.removeWorkspace(workflow.config, outcome.issue.identifier);
        this.releaseClaim(issueId);
        return;
      }

      if (isActiveState(outcome.issue.state, workflow.config)) {
        this.scheduleRetry(issueId, 1, {
          identifier: entry.identifier,
          error: null,
          continuation: true
        }, workflow.config);
        return;
      }

      this.releaseClaim(issueId);
      return;
    }

    if (outcome.kind === "canceled_non_active") {
      this.releaseClaim(issueId);
      return;
    }

    if (outcome.kind === "canceled_terminal") {
      await this.workspaceManager.removeWorkspace(workflow.config, outcome.issue.identifier);
      this.releaseClaim(issueId);
      return;
    }

    this.scheduleRetry(issueId, nextAttemptFrom(entry), {
      identifier: entry.identifier,
      error: outcome.error,
      continuation: false
    }, workflow.config);
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

    const workflow = await this.workflowManager.getCurrent();
    const tracker = createTrackerClient(workflow.config, this.logger);

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

      this.scheduleRetry(issueId, retryEntry.attempt + 1, {
        identifier: issue.identifier,
        error: "no available orchestrator slots",
        continuation: false
      }, workflow.config);
    } catch (error) {
      this.scheduleRetry(issueId, retryEntry.attempt + 1, {
        identifier: retryEntry.identifier,
        error: "retry poll failed",
        continuation: false
      }, workflow.config);
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

    const tracker = createTrackerClient(config, this.logger);
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
    this.logger.info("worker cancellation requested", {
      issue_id: issueId,
      issue_identifier: entry.identifier,
      reason
    });
  }

  private handleCodexEvent(issueId: string, event: { event: string; timestamp: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number }; rateLimits?: unknown; message?: string; sessionId?: string; threadId?: string; turnId?: string; codexAppServerPid: number | null }): void {
    const entry = this.running.get(issueId);
    if (!entry) {
      return;
    }

    entry.codexAppServerPid = event.codexAppServerPid;
    entry.lastCodexEvent = event.event;
    entry.lastCodexMessage = event.message ?? event.event;
    entry.lastCodexTimestampMs = Date.parse(event.timestamp);

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
    params: { identifier: string; error: string | null; continuation: boolean },
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
      attempt,
      dueAtMs: Date.now() + delayMs,
      timerHandle,
      error: params.error
    });
    this.claimed.add(issueId);
    this.logger.info("retry scheduled", {
      issue_id: issueId,
      issue_identifier: params.identifier,
      attempt,
      delay_ms: delayMs,
      error: params.error,
      continuation: params.continuation
    });
  }

  private releaseClaim(issueId: string): void {
    const retry = this.retryAttempts.get(issueId);
    if (retry) {
      clearTimeout(retry.timerHandle);
      this.retryAttempts.delete(issueId);
    }

    this.claimed.delete(issueId);
  }

  private async startupTerminalWorkspaceCleanup(workflow: LoadedWorkflow): Promise<void> {
    const tracker = createTrackerClient(workflow.config, this.logger);
    try {
      const terminalIssues = await tracker.fetchIssuesByStates(workflow.config.tracker.terminalStates);
      for (const issue of terminalIssues) {
        await this.workspaceManager.removeWorkspace(workflow.config, issue.identifier);
      }
    } catch (error) {
      this.logger.errorWithCause("startup terminal workspace cleanup failed", error);
    }
  }
}

function nextAttemptFrom(entry: RunningEntry): number {
  return entry.retryAttempt === null ? 1 : entry.retryAttempt + 1;
}
