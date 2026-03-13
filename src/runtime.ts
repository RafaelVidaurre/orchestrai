import path from "node:path";

import type { LoadedWorkflow, StatusSnapshot, StatusSource } from "./domain";
import { loadWorkflowEnv } from "./env";
import { Logger } from "./logger";
import { Orchestrator } from "./orchestrator";

interface ManagedRuntime {
  orchestrator: Orchestrator;
  workflowPath: string;
  workflow: LoadedWorkflow;
  unsubscribe: (() => void) | null;
}

export class RuntimeManager implements StatusSource {
  private readonly runtimes: ManagedRuntime[] = [];
  private readonly subscribers = new Set<(snapshot: StatusSnapshot) => void>();

  constructor(
    private readonly workflowPaths: string[],
    private readonly logger: Logger = new Logger(),
    private readonly baseEnv: NodeJS.ProcessEnv = process.env
  ) {}

  async start(): Promise<void> {
    for (const workflowPath of this.workflowPaths) {
      const scopedLogger = this.logger.child({
        workflow_path: workflowPath
      });
      const env = await loadWorkflowEnv(path.dirname(workflowPath), this.baseEnv, scopedLogger.child({ component: "env" }));
      const orchestrator = new Orchestrator(workflowPath, scopedLogger, env);

      try {
        await orchestrator.start();
        const workflow = await orchestrator.getCurrentWorkflow();
        const runtime: ManagedRuntime = {
          orchestrator,
          workflowPath,
          workflow,
          unsubscribe: null
        };
        runtime.unsubscribe = orchestrator.subscribe(() => {
          void this.refreshWorkflow(runtime).catch(() => undefined);
          this.publishSnapshot();
        });
        this.runtimes.push(runtime);
      } catch (error) {
        await this.stop().catch(() => undefined);
        throw error;
      }
    }

    this.publishSnapshot();
  }

  async stop(): Promise<void> {
    const stops = this.runtimes.map(async (runtime) => {
      runtime.unsubscribe?.();
      runtime.unsubscribe = null;
      await runtime.orchestrator.stop();
    });
    await Promise.all(stops);
    this.runtimes.splice(0, this.runtimes.length);
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    this.subscribers.add(listener);
    if (this.runtimes.length > 0) {
      listener(this.snapshot());
    }
    return () => {
      this.subscribers.delete(listener);
    };
  }

  snapshot(): StatusSnapshot {
    const snapshots = this.runtimes.map((runtime) => runtime.orchestrator.snapshot());
    return combineSnapshots(snapshots);
  }

  dashboardConfig(): { host: string; port: number } | null {
    const eligible = this.runtimes
      .map((runtime) => ({
        workflow_path: runtime.workflow.config.workflowPath,
        ...runtime.workflow.config.server
      }))
      .filter((server) => server.port >= 0);

    if (eligible.length === 0) {
      return null;
    }

    for (const server of eligible.slice(1)) {
      if (server.host !== eligible[0].host || server.port !== eligible[0].port) {
        this.logger.warn("multiple workflows configured different dashboard addresses; using the first enabled server", {
          selected_workflow_path: eligible[0].workflow_path,
          selected_host: eligible[0].host,
          selected_port: eligible[0].port,
          ignored_workflow_path: server.workflow_path,
          ignored_host: server.host,
          ignored_port: server.port
        });
      }
    }

    return {
      host: eligible[0].host,
      port: eligible[0].port
    };
  }

  private async refreshWorkflow(runtime: ManagedRuntime): Promise<void> {
    runtime.workflow = await runtime.orchestrator.getCurrentWorkflow();
  }

  private publishSnapshot(): void {
    if (this.runtimes.length === 0) {
      return;
    }

    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }
}

function combineSnapshots(snapshots: StatusSnapshot[]): StatusSnapshot {
  const combined = {
    updated_at: new Date().toISOString(),
    project_count: snapshots.reduce((sum, snapshot) => sum + snapshot.project_count, 0),
    running_count: snapshots.reduce((sum, snapshot) => sum + snapshot.running_count, 0),
    retry_count: snapshots.reduce((sum, snapshot) => sum + snapshot.retry_count, 0),
    completed_count: snapshots.reduce((sum, snapshot) => sum + snapshot.completed_count, 0),
    claimed_count: snapshots.reduce((sum, snapshot) => sum + snapshot.claimed_count, 0),
    projects: snapshots.flatMap((snapshot) => snapshot.projects),
    running: snapshots.flatMap((snapshot) => snapshot.running),
    retries: snapshots.flatMap((snapshot) => snapshot.retries),
    codex_totals: snapshots.reduce(
      (totals, snapshot) => {
        totals.inputTokens += snapshot.codex_totals.inputTokens;
        totals.outputTokens += snapshot.codex_totals.outputTokens;
        totals.totalTokens += snapshot.codex_totals.totalTokens;
        totals.secondsRunning += snapshot.codex_totals.secondsRunning;
        return totals;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0
      }
    ),
    recent_events: snapshots
      .flatMap((snapshot) => snapshot.recent_events)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 80)
  } satisfies StatusSnapshot;

  combined.projects.sort((left, right) => left.linear_project.slug.localeCompare(right.linear_project.slug));
  combined.running.sort((left, right) => left.identifier.localeCompare(right.identifier));
  combined.retries.sort((left, right) => left.due_at_ms - right.due_at_ms);

  return combined;
}
