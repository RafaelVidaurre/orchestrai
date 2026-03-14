import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentProvider,
  AgentUsageSnapshot,
  FatalProjectError,
  LoadedWorkflow,
  StatusProjectState,
  StatusSnapshot,
  StatusSource
} from "./domain";
import { buildServiceConfig } from "./config";
import { loadWorkflowEnv } from "./env";
import {
  classifyFatalRuntimeError,
  clearFatalProjectError,
  readFatalProjectError,
  recordFatalProjectError,
  type FatalRuntimeErrorInput
} from "./fatal-runtime-errors";
import { Logger } from "./logger";
import { Orchestrator } from "./orchestrator";
import { parseWorkflowFile } from "./workflow";

interface ManagedRuntime {
  orchestrator: Orchestrator;
  workflowPath: string;
  workflow: LoadedWorkflow;
  unsubscribe: (() => void) | null;
}

interface WorkflowRuntimeState {
  workflowPath: string;
  enabled: boolean;
  runtimeRunning: boolean;
  fatalError: FatalProjectError | null;
  updatedAt: string;
}

interface RuntimeManagerOptions {
  onFatalError?: (input: FatalRuntimeErrorInput) => Promise<FatalProjectError>;
  onUsageDelta?: (input: {
    workflowPath: string;
    projectSlug: string;
    displayName: string | null;
    provider: AgentProvider;
    model: string;
    usage: AgentUsageSnapshot;
    observedAt: string;
  }) => Promise<void>;
}

export class RuntimeManager implements StatusSource {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly workflowPaths = new Set<string>();
  private readonly disabledWorkflowPaths = new Set<string>();
  private readonly projectStates = new Map<string, WorkflowRuntimeState>();
  private readonly fatalWorkflowPaths = new Set<string>();
  private readonly subscribers = new Set<(snapshot: StatusSnapshot) => void>();
  private started = false;

  constructor(
    workflowPaths: string[],
    private readonly projectsRoot: string | null,
    private readonly logger: Logger = new Logger(),
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly options: RuntimeManagerOptions = {}
  ) {
    workflowPaths.map((workflowPath) => path.resolve(workflowPath)).forEach((workflowPath) => {
      this.workflowPaths.add(workflowPath);
      this.ensureWorkflowState(workflowPath);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    for (const workflowPath of this.workflowPaths) {
      await this.syncWorkflowEnabledState(workflowPath);
      if (!this.disabledWorkflowPaths.has(workflowPath)) {
        await this.startWorkflow(workflowPath);
      }
    }

    this.publishSnapshot();
  }

  async stop(): Promise<void> {
    this.started = false;

    const stops = [...this.runtimes.values()].map(async (runtime) => {
      runtime.unsubscribe?.();
      runtime.unsubscribe = null;
      await runtime.orchestrator.stop();
    });
    await Promise.all(stops);
    this.runtimes.clear();
    for (const workflowPath of this.workflowPaths) {
      this.updateWorkflowState(workflowPath, {
        runtimeRunning: false
      });
    }
    this.publishSnapshot();
  }

  async addWorkflow(workflowPath: string): Promise<boolean> {
    const absolutePath = path.resolve(workflowPath);
    if (this.workflowPaths.has(absolutePath)) {
      return false;
    }

    this.workflowPaths.add(absolutePath);
    this.ensureWorkflowState(absolutePath);
    await this.syncWorkflowEnabledState(absolutePath);
    if (this.started) {
      if (!this.disabledWorkflowPaths.has(absolutePath)) {
        await this.startWorkflow(absolutePath);
      }
      this.publishSnapshot();
    }

    return true;
  }

  async reloadWorkflow(workflowPath: string): Promise<void> {
    const absolutePath = path.resolve(workflowPath);
    this.workflowPaths.add(absolutePath);
    this.ensureWorkflowState(absolutePath);
    await this.syncWorkflowEnabledState(absolutePath);
    await this.stopManagedRuntime(absolutePath);
    if (this.started && !this.disabledWorkflowPaths.has(absolutePath)) {
      await this.startWorkflow(absolutePath);
    }

    this.publishSnapshot();
  }

  async removeWorkflow(workflowPath: string): Promise<boolean> {
    const absolutePath = path.resolve(workflowPath);
    const hadPath = this.workflowPaths.delete(absolutePath);
    this.disabledWorkflowPaths.delete(absolutePath);
    const removed = await this.stopManagedRuntime(absolutePath);
    this.projectStates.delete(absolutePath);
    if (hadPath || removed) {
      this.publishSnapshot();
    }
    return hadPath || removed;
  }

  async enableWorkflow(workflowPath: string): Promise<boolean> {
    const absolutePath = path.resolve(workflowPath);
    const hadPath = this.workflowPaths.has(absolutePath);
    this.workflowPaths.add(absolutePath);
    this.ensureWorkflowState(absolutePath);
    this.disabledWorkflowPaths.delete(absolutePath);
    this.updateWorkflowState(absolutePath, {
      enabled: true,
      fatalError: null
    });

    if (!this.started) {
      this.started = true;
    }

    await this.startWorkflow(absolutePath);
    this.publishSnapshot();
    return !hadPath || this.runtimes.has(absolutePath);
  }

  async disableWorkflow(workflowPath: string): Promise<boolean> {
    const absolutePath = path.resolve(workflowPath);
    this.disabledWorkflowPaths.add(absolutePath);
    this.updateWorkflowState(absolutePath, {
      enabled: false,
      runtimeRunning: false
    });
    const removed = await this.stopManagedRuntime(absolutePath);
    this.publishSnapshot();
    return removed;
  }

  isWorkflowRunning(workflowPath: string): boolean {
    return this.runtimes.has(path.resolve(workflowPath));
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot());
    return () => {
      this.subscribers.delete(listener);
    };
  }

  snapshot(): StatusSnapshot {
    const snapshots = [...this.runtimes.values()].map((runtime) => runtime.orchestrator.snapshot());
    return combineSnapshots(snapshots, [...this.projectStates.values()]);
  }

  dashboardConfig(): { host: string; port: number } | null {
    const eligible = [...this.runtimes.values()]
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
    const snapshot = this.snapshot();
    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }

  private async startWorkflow(workflowPath: string): Promise<void> {
    if (this.runtimes.has(workflowPath)) {
      return;
    }

    const scopedLogger = this.logger.child({
      workflow_path: workflowPath
    });
    const env = await loadWorkflowEnv(
      path.dirname(workflowPath),
      this.baseEnv,
      scopedLogger.child({ component: "env" }),
      this.projectsRoot
    );
    const orchestrator = new Orchestrator(workflowPath, scopedLogger, env, {
      onFatalError: (input) => this.handleFatalError(input),
      onUsageDelta: (input) => this.options.onUsageDelta?.(input)
    });

    try {
      await orchestrator.start();
    } catch (error) {
      await orchestrator.stop().catch(() => undefined);
      const handled = await this.handleFatalError({
        workflowPath,
        provider: null,
        stage: "startup",
        error
      });
      if (handled) {
        return;
      }
      throw error;
    }

    await clearFatalProjectError(workflowPath).catch(() => undefined);
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
    this.runtimes.set(workflowPath, runtime);
    this.updateWorkflowState(workflowPath, {
      enabled: true,
      runtimeRunning: true,
      fatalError: null
    });
  }

  private async syncWorkflowEnabledState(workflowPath: string): Promise<void> {
    const [enabled, fatalError] = await Promise.all([
      readWorkflowEnabled(
        workflowPath,
        this.baseEnv,
        this.projectsRoot,
        this.logger.child({ workflow_path: workflowPath })
      ),
      readFatalProjectError(workflowPath)
    ]);
    this.updateWorkflowState(workflowPath, {
      enabled,
      fatalError
    });
    if (enabled) {
      this.disabledWorkflowPaths.delete(workflowPath);
      return;
    }

    this.disabledWorkflowPaths.add(workflowPath);
  }

  private async stopManagedRuntime(workflowPath: string): Promise<boolean> {
    const runtime = this.runtimes.get(workflowPath);
    if (!runtime) {
      this.updateWorkflowState(workflowPath, {
        runtimeRunning: false
      });
      return false;
    }

    runtime.unsubscribe?.();
    runtime.unsubscribe = null;
    await runtime.orchestrator.stop();
    this.runtimes.delete(workflowPath);
    this.updateWorkflowState(workflowPath, {
      runtimeRunning: false
    });
    return true;
  }

  private ensureWorkflowState(workflowPath: string): WorkflowRuntimeState {
    const absolutePath = path.resolve(workflowPath);
    const existing = this.projectStates.get(absolutePath);
    if (existing) {
      return existing;
    }

    const created: WorkflowRuntimeState = {
      workflowPath: absolutePath,
      enabled: true,
      runtimeRunning: false,
      fatalError: null,
      updatedAt: new Date().toISOString()
    };
    this.projectStates.set(absolutePath, created);
    return created;
  }

  private updateWorkflowState(workflowPath: string, updates: Partial<Omit<WorkflowRuntimeState, "workflowPath">>): void {
    const state = this.ensureWorkflowState(workflowPath);
    if (updates.enabled !== undefined) {
      state.enabled = updates.enabled;
    }
    if (updates.runtimeRunning !== undefined) {
      state.runtimeRunning = updates.runtimeRunning;
    }
    if (updates.fatalError !== undefined) {
      state.fatalError = updates.fatalError;
    }
    state.updatedAt = new Date().toISOString();
  }

  private async handleFatalError(input: FatalRuntimeErrorInput): Promise<boolean> {
    const workflowPath = path.resolve(input.workflowPath);
    if (!classifyFatalRuntimeError(input)) {
      return false;
    }
    if (this.fatalWorkflowPaths.has(workflowPath)) {
      return true;
    }

    this.fatalWorkflowPaths.add(workflowPath);
    try {
      const fatalError = this.options.onFatalError
        ? await this.options.onFatalError({
            ...input,
            workflowPath
          })
        : await recordFatalProjectError({
            ...input,
            workflowPath
          });
      this.disabledWorkflowPaths.add(workflowPath);
      this.updateWorkflowState(workflowPath, {
        enabled: false,
        runtimeRunning: false,
        fatalError
      });
      await this.stopManagedRuntime(workflowPath);
      this.publishSnapshot();
      return true;
    } finally {
      this.fatalWorkflowPaths.delete(workflowPath);
    }
  }
}

async function readWorkflowEnabled(
  workflowPath: string,
  baseEnv: NodeJS.ProcessEnv,
  projectsRoot: string | null,
  logger: Logger
): Promise<boolean> {
  const env = await loadWorkflowEnv(path.dirname(workflowPath), baseEnv, logger.child({ component: "env" }), projectsRoot);
  const content = await readFile(workflowPath, "utf8");
  const definition = parseWorkflowFile(content);
  return buildServiceConfig(workflowPath, definition, env).project.enabled;
}

function combineSnapshots(snapshots: StatusSnapshot[], projectStates: WorkflowRuntimeState[]): StatusSnapshot {
  const combined = {
    updated_at: new Date().toISOString(),
    project_count: projectStates.length,
    running_count: snapshots.reduce((sum, snapshot) => sum + snapshot.running_count, 0),
    retry_count: snapshots.reduce((sum, snapshot) => sum + snapshot.retry_count, 0),
    completed_count: snapshots.reduce((sum, snapshot) => sum + snapshot.completed_count, 0),
    claimed_count: snapshots.reduce((sum, snapshot) => sum + snapshot.claimed_count, 0),
    projects: snapshots.flatMap((snapshot) => snapshot.projects),
    project_states: projectStates.map((state) => ({
      workflow_path: state.workflowPath,
      enabled: state.enabled,
      runtime_running: state.runtimeRunning,
      fatal_error: state.fatalError,
      updated_at: state.updatedAt
    } satisfies StatusProjectState)),
    running: snapshots.flatMap((snapshot) => snapshot.running),
    retries: snapshots.flatMap((snapshot) => snapshot.retries),
    agent_totals: snapshots.reduce(
      (totals, snapshot) => {
        totals.inputTokens += snapshot.agent_totals.inputTokens;
        totals.outputTokens += snapshot.agent_totals.outputTokens;
        totals.totalTokens += snapshot.agent_totals.totalTokens;
        totals.costUsd += snapshot.agent_totals.costUsd;
        totals.unpricedTotalTokens += snapshot.agent_totals.unpricedTotalTokens;
        totals.secondsRunning += snapshot.agent_totals.secondsRunning;
        return totals;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        unpricedTotalTokens: 0,
        secondsRunning: 0
      }
    ),
    session_model_usage: snapshots
      .flatMap((snapshot) => snapshot.session_model_usage)
      .sort(
        (left, right) =>
          right.cost_usd - left.cost_usd ||
          right.total_tokens - left.total_tokens ||
          left.model.localeCompare(right.model) ||
          left.workflow_path.localeCompare(right.workflow_path)
      ),
    recent_events: snapshots
      .flatMap((snapshot) => snapshot.recent_events)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 80)
  } satisfies StatusSnapshot;

  combined.projects.sort((left, right) => left.linear_project.slug.localeCompare(right.linear_project.slug));
  combined.project_states.sort((left, right) => left.workflow_path.localeCompare(right.workflow_path));
  combined.running.sort((left, right) => left.identifier.localeCompare(right.identifier));
  combined.retries.sort((left, right) => left.due_at_ms - right.due_at_ms);

  return combined;
}
