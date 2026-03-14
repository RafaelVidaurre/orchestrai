import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildServiceConfig, validateDispatchConfig } from "./config";
import type {
  DashboardSetupContext,
  GlobalConfigInput,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  ProviderDescriptor,
  ProviderModelCatalog,
  ProviderModelQuery,
  StatusSnapshot,
  StatusSource,
  UsageMetricsSnapshot,
  ProjectUsageBudgetInput,
  ProjectUsageMetrics,
  UsageHistoryClearInput
} from "./domain";
import type { ConfigBackedProjectCreateInput } from "./config-backed-projects";
import { ConfigBackedProjectsService } from "./config-backed-projects";
import { ServiceError } from "./errors";
import { loadWorkflowEnv } from "./env";
import { Logger } from "./logger";
import { getActiveProviderRegistry, loadProviderRegistry, type ProviderRegistry } from "./provider-registry";
import { RuntimeManager } from "./runtime";
import { UsageMetricsStore } from "./usage-metrics";
import { parseWorkflowFile } from "./workflow";

export interface ControlPlaneState {
  runtimeRunning: boolean;
  dashboardRunning: boolean;
  dashboardUrl: string | null;
  projectsRoot: string;
  configuredWorkflowCount: number;
}

export class ControlPlaneService implements StatusSource {
  private readonly runtime: RuntimeManager;
  private readonly usageMetricsStore: UsageMetricsStore;
  private readonly projects: ConfigBackedProjectsService;
  private readonly knownWorkflowPaths = new Set<string>();
  private readonly stateSubscribers = new Set<(state: ControlPlaneState) => void>();
  private registry: ProviderRegistry;
  private runtimeRunning = false;
  private dashboardRunning = false;
  private dashboardUrl: string | null = null;
  private initialized = false;

  constructor(
    private readonly projectsRoot: string,
    private readonly logger: Logger = new Logger(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.registry = getActiveProviderRegistry();
    this.projects = new ConfigBackedProjectsService(projectsRoot, env, this.registry);
    this.usageMetricsStore = new UsageMetricsStore(projectsRoot);
    this.runtime = new RuntimeManager([], path.resolve(projectsRoot), logger.child({ component: "runtime-manager" }), env, {
      onUsageDelta: async (input) => {
        await this.usageMetricsStore.recordUsage(input);
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.projects.initConfig();
    this.registry = await loadProviderRegistry(this.projectsRoot);
    this.projects.setRegistry(this.registry);
    this.initialized = true;
    await this.refreshCompiledWorkflows();
    this.publishState();
  }

  snapshot(): StatusSnapshot {
    return this.runtime.snapshot();
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  subscribeState(listener: (state: ControlPlaneState) => void): () => void {
    this.stateSubscribers.add(listener);
    listener(this.state());
    return () => {
      this.stateSubscribers.delete(listener);
    };
  }

  state(): ControlPlaneState {
    return {
      runtimeRunning: this.runtimeRunning,
      dashboardRunning: this.dashboardRunning,
      dashboardUrl: this.dashboardUrl,
      projectsRoot: path.resolve(this.projectsRoot),
      configuredWorkflowCount: this.knownWorkflowPaths.size
    };
  }

  setDashboardState(running: boolean, url: string | null): void {
    this.dashboardRunning = running;
    this.dashboardUrl = url;
    this.publishState();
  }

  async startRuntime(): Promise<void> {
    await this.initialize();
    await this.assertEnabledProjectsStartable();
    if (this.runtimeRunning) {
      return;
    }
    await this.runtime.start();
    this.runtimeRunning = true;
    this.publishState();
  }

  async stopRuntime(): Promise<void> {
    if (!this.runtimeRunning) {
      return;
    }
    await this.runtime.stop();
    this.runtimeRunning = false;
    this.publishState();
  }

  async stop(): Promise<void> {
    await this.stopRuntime();
    await this.usageMetricsStore.flush().catch(() => undefined);
  }

  async dashboardSetupContext(): Promise<DashboardSetupContext> {
    return {
      projectsRoot: path.resolve(this.projectsRoot),
      trackerKind: "linear",
      repositoryProvider: "github",
      globalConfig: await this.projects.readGlobalConfig()
    };
  }

  async readGlobalConfig(): Promise<GlobalConfigRecord> {
    return this.projects.readGlobalConfig();
  }

  async updateGlobalConfig(input: GlobalConfigInput): Promise<GlobalConfigRecord> {
    const next = await this.projects.updateGlobalConfig(input);
    await this.refreshCompiledWorkflows(true);
    return next;
  }

  async listProviderModels(input: ProviderModelQuery): Promise<ProviderModelCatalog> {
    const plugin = this.registry.get(input.provider);
    return plugin.listModels({
      provider: input.provider,
      projectId: input.projectId ?? null,
      baseEnv: this.env,
      projectsRoot: this.projectsRoot,
      useStoredKey: input.useStoredKey,
      typedSecrets: {
        XAI_API_KEY: typeof input.xaiApiKey === "string" ? input.xaiApiKey : undefined
      }
    });
  }

  listProviders(): ProviderDescriptor[] {
    return this.registry.list().map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      defaultModel: plugin.defaultModel
    }));
  }

  async usageMetrics(): Promise<UsageMetricsSnapshot> {
    await this.initialize();
    return this.usageMetricsStore.snapshot(this.knownWorkflowPaths);
  }

  async updateUsageBudget(input: ProjectUsageBudgetInput): Promise<ProjectUsageMetrics> {
    return this.usageMetricsStore.updateBudget({
      ...input,
      id: this.resolveWorkflowPath(input.id)
    });
  }

  async clearUsageHistory(input: UsageHistoryClearInput): Promise<UsageMetricsSnapshot> {
    await this.initialize();
    await this.usageMetricsStore.clearHistory(input.id ? this.resolveWorkflowPath(input.id) : undefined);
    return this.usageMetricsStore.snapshot(this.knownWorkflowPaths);
  }

  async listProjects(): Promise<ManagedProjectRecord[]> {
    await this.initialize();
    const records = await this.projects.listProjects();
    return records.map((record) => ({
      ...record,
      runtimeRunning: this.runtime.isWorkflowRunning(record.workflowPath)
    }));
  }

  async createProject(input: ConfigBackedProjectCreateInput): Promise<ProjectSetupResult> {
    await this.initialize();
    const created = await this.projects.createProject(input);
    await this.refreshCompiledWorkflows(true);
    return this.refreshProjectRuntimeState(created);
  }

  async updateProject(input: ProjectUpdateInput): Promise<ManagedProjectRecord> {
    await this.initialize();
    const updated = await this.projects.updateProject(input);
    await this.refreshCompiledWorkflows(true);
    return this.refreshProjectRuntimeState(updated);
  }

  async startProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord> {
    await this.initialize();
    await this.assertProjectStartable(input.id);
    const updated = await this.projects.setProjectEnabled(input, true);
    await this.refreshCompiledWorkflows(true);
    return this.refreshProjectRuntimeState(updated);
  }

  async stopProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord> {
    await this.initialize();
    const updated = await this.projects.setProjectEnabled(input, false);
    await this.refreshCompiledWorkflows(true);
    return this.refreshProjectRuntimeState(updated);
  }

  async removeProject(id: string): Promise<void> {
    await this.initialize();
    const workflowPath = this.resolveWorkflowPath(id);
    await this.projects.removeProject(id);
    if (this.knownWorkflowPaths.has(workflowPath)) {
      this.knownWorkflowPaths.delete(workflowPath);
      await this.runtime.removeWorkflow(workflowPath);
      await this.usageMetricsStore.removeProject(workflowPath);
    }
    this.publishState();
  }

  private async refreshCompiledWorkflows(reloadExisting = false): Promise<void> {
    const workflowPaths = (await this.projects.syncRuntimeArtifacts()).map((workflowPath) => path.resolve(workflowPath));
    const nextPaths = new Set(workflowPaths);

    for (const workflowPath of workflowPaths) {
      if (!this.knownWorkflowPaths.has(workflowPath)) {
        this.knownWorkflowPaths.add(workflowPath);
        await this.runtime.addWorkflow(workflowPath);
      } else if (reloadExisting) {
        await this.runtime.reloadWorkflow(workflowPath);
      }
    }

    for (const workflowPath of [...this.knownWorkflowPaths]) {
      if (!nextPaths.has(workflowPath)) {
        this.knownWorkflowPaths.delete(workflowPath);
        await this.runtime.removeWorkflow(workflowPath);
      }
    }

    this.publishState();
  }

  private resolveWorkflowPath(projectId: string): string {
    return path.join(path.resolve(this.projectsRoot), ".orchestrai", "runtime", "projects", projectId, "WORKFLOW.md");
  }

  private publishState(): void {
    const state = this.state();
    for (const listener of this.stateSubscribers) {
      listener(state);
    }
  }

  private refreshProjectRuntimeState<T extends ManagedProjectRecord>(project: T): T {
    return {
      ...project,
      runtimeRunning: this.runtime.isWorkflowRunning(project.workflowPath)
    };
  }

  private async assertEnabledProjectsStartable(): Promise<void> {
    const projects = await this.projects.listProjects();
    const failures: string[] = [];

    for (const project of projects) {
      if (!project.enabled) {
        continue;
      }

      try {
        await this.validateProjectRuntime(project.id);
      } catch (error) {
        failures.push(`${project.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length === 0) {
      return;
    }

    throw new ServiceError("runtime_preflight_failed", `Runtime preflight failed:\n${failures.join("\n")}`);
  }

  private async assertProjectStartable(projectId: string): Promise<void> {
    try {
      await this.validateProjectRuntime(projectId);
    } catch (error) {
      throw new ServiceError(
        "project_start_validation_failed",
        `Project ${projectId} cannot be started: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async validateProjectRuntime(projectId: string): Promise<void> {
    const workflowPath = this.resolveWorkflowPath(projectId);
    const workflowSource = await readFile(workflowPath, "utf8");
    const envForWorkflow = await loadWorkflowEnv(
      path.dirname(workflowPath),
      this.env,
      this.logger.child({ component: "preflight-env", project_id: projectId }),
      this.projectsRoot
    );
    const workflow = parseWorkflowFile(workflowSource);
    const config = buildServiceConfig(workflowPath, workflow, envForWorkflow);
    validateDispatchConfig(config);

    const plugin = this.registry.get(config.runtime.provider);
    const findings = (await plugin.doctor?.(config, envForWorkflow)) ?? [];
    const errors = findings
      .filter((finding) => finding.level === "error")
      .map((finding) => finding.message.trim())
      .filter((message) => message.length > 0);
    if (errors.length > 0) {
      throw new ServiceError("project_start_validation_failed", errors.join("; "));
    }
  }
}
