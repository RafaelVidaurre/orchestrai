import type { CodexRuntimeEvent, Issue, LoadedWorkflow, ServiceConfig, WorkerCancelReason, WorkerOutcome } from "./domain";
import { CodexAppServerSession } from "./codex";
import { ServiceError, errorMessage } from "./errors";
import { Logger } from "./logger";
import { createTrackerClient } from "./tracker";
import { isActiveState } from "./utils";
import { renderPrompt } from "./workflow";
import { WorkspaceManager } from "./workspace";

export class IssueWorker {
  private readonly tracker;
  private readonly workspaceManager: WorkspaceManager;
  private cancelReason: WorkerCancelReason | null = null;
  private session: CodexAppServerSession | null = null;
  readonly result: Promise<WorkerOutcome>;

  constructor(
    private readonly issue: Issue,
    private readonly attempt: number | null,
    private readonly workflow: LoadedWorkflow,
    logger: Logger,
    private readonly onCodexEvent: (event: CodexRuntimeEvent) => void
  ) {
    this.workspaceManager = new WorkspaceManager(logger.child({ component: "workspace" }));
    this.tracker = createTrackerClient(this.workflow.config, logger.child({ component: "tracker" }));
    this.logger = logger.child({
      component: "worker",
      issue_id: issue.id,
      issue_identifier: issue.identifier
    });
    this.result = this.run();
  }

  private readonly logger: Logger;

  cancel(reason: WorkerCancelReason): void {
    this.cancelReason = reason;
    void this.session?.stop();
  }

  private async run(): Promise<WorkerOutcome> {
    let currentIssue = this.issue;
    let turnCount = 0;
    let workspacePath: string | null = null;

    try {
      const workspace = await this.workspaceManager.ensureWorkspace(this.workflow.config, this.issue.identifier);
      workspacePath = workspace.path;
      await this.workspaceManager.prepareWorkspace(this.workflow.config, workspace.path);
      await this.workspaceManager.runBeforeRun(this.workflow.config, workspace.path);

      this.session = new CodexAppServerSession(
        this.workflow.config,
        workspace.path,
        this.logger.child({ component: "codex" }),
        this.onCodexEvent
      );

      const { threadId } = await this.session.start();

      while (true) {
        this.assertNotCancelled();
        turnCount += 1;

        const prompt =
          turnCount === 1
            ? await renderPrompt(this.workflow.definition, currentIssue, this.attempt)
            : buildContinuationPrompt(currentIssue, turnCount, this.workflow.config.agent.maxTurns);

        await this.session.runTurn(threadId, prompt);
        const refreshedIssues = await this.tracker.fetchIssueStatesByIds([currentIssue.id]);
        currentIssue = refreshedIssues[0] ?? currentIssue;

        if (!isActiveState(currentIssue.state, this.workflow.config)) {
          break;
        }

        if (turnCount >= this.workflow.config.agent.maxTurns) {
          break;
        }
      }

      if (this.cancelReason) {
        return cancelledOutcome(this.cancelReason, currentIssue, turnCount);
      }

      return {
        kind: "normal",
        issue: currentIssue,
        turnCount
      };
    } catch (error) {
      if (this.cancelReason) {
        return cancelledOutcome(this.cancelReason, currentIssue, turnCount);
      }

      if (error instanceof ServiceError && error.code === "turn_timeout") {
        return {
          kind: "timed_out",
          error: error.message,
          issue: currentIssue,
          turnCount
        };
      }

      if (error instanceof ServiceError && error.code === "turn_input_required") {
        return {
          kind: "failed",
          error: error.message,
          issue: currentIssue,
          turnCount
        };
      }

      return {
        kind: "failed",
        error: errorMessage(error),
        issue: currentIssue,
        turnCount
      };
    } finally {
      await this.session?.stop().catch(() => undefined);
      if (workspacePath) {
        await this.workspaceManager.runAfterRun(this.workflow.config, workspacePath);
      }
    }
  }

  private assertNotCancelled(): void {
    if (this.cancelReason) {
      throw new ServiceError("worker_cancelled", `Worker cancelled: ${this.cancelReason}`);
    }
  }
}

function buildContinuationPrompt(issue: Issue, turnNumber: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    "The original task prompt and prior work are already in thread history.",
    `This is continuation turn ${turnNumber} of ${maxTurns}.`,
    "Inspect the current repo state, continue from existing progress, and move the issue to the next correct handoff state if the work is complete."
  ].join("\n");
}

function cancelledOutcome(reason: WorkerCancelReason, issue: Issue, turnCount: number): WorkerOutcome {
  switch (reason) {
    case "stalled":
      return {
        kind: "stalled",
        error: "Worker stalled and was terminated",
        issue,
        turnCount
      };
    case "canceled_non_active":
      return {
        kind: "canceled_non_active",
        error: "Issue became non-active during reconciliation",
        issue,
        turnCount
      };
    case "canceled_terminal":
      return {
        kind: "canceled_terminal",
        error: "Issue became terminal during reconciliation",
        issue,
        turnCount
      };
    case "service_stopping":
      return {
        kind: "service_stopping",
        error: "Service is stopping",
        issue,
        turnCount
      };
  }
}
