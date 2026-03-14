import path from "node:path";

import type {
  DashboardSetupContext,
  GlobalConfigInput,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  StatusSnapshot,
  StatusSource
} from "./domain";
import { Logger } from "./logger";
import {
  createProjectSetup,
  listProjectSetups,
  removeProjectSetup,
  setProjectEnabled,
  updateProjectSetup
} from "./project-setup";
import { readGlobalConfig, updateGlobalConfig } from "./global-config";
import { RuntimeManager } from "./runtime";
import { StatusServer } from "./status-server";
import type { WorkflowContext } from "./workflow";

const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 4318;

export interface AppControlState {
  runtimeRunning: boolean;
  dashboardRunning: boolean;
  dashboardUrl: string | null;
  projectsRoot: string;
  configuredWorkflowCount: number;
}

export class AppController implements StatusSource {
  private readonly runtime: RuntimeManager;
  private readonly knownWorkflowPaths: Set<string>;
  private readonly subscribers = new Set<(state: AppControlState) => void>();
  private readonly setupContextValue: DashboardSetupContext;
  private statusServer: StatusServer | null = null;
  private dashboardInfo: { host: string; port: number; url: string } | null = null;
  private runtimeRunning = false;

  constructor(
    private readonly workflowContext: WorkflowContext,
    private readonly logger: Logger = new Logger(),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.knownWorkflowPaths = new Set(workflowContext.workflowPaths.map((workflowPath) => path.resolve(workflowPath)));
    this.runtime = new RuntimeManager(
      [...this.knownWorkflowPaths],
      path.resolve(workflowContext.projectsRoot),
      logger.child({ component: "runtime-manager" }),
      env
    );
    this.setupContextValue = {
      projectsRoot: path.resolve(workflowContext.projectsRoot),
      trackerKind: "linear",
      repositoryProvider: "github",
      globalConfig: {
        projectsRoot: path.resolve(workflowContext.projectsRoot),
        envFilePath: path.join(path.resolve(workflowContext.projectsRoot), ".env.local"),
        defaults: {
          pollingIntervalMs: 30000,
          maxConcurrentAgents: 10,
          agentProvider: "codex",
          agentModel: ""
        },
        hasLinearApiKey: false,
        hasXaiApiKey: false,
        hasGithubToken: false
      }
    };
  }

  async start(options: { runtime?: boolean; dashboard?: boolean } = {}): Promise<void> {
    const shouldStartRuntime = options.runtime ?? true;
    const shouldStartDashboard = options.dashboard ?? true;

    if (shouldStartRuntime) {
      await this.startRuntime();
    }

    if (shouldStartDashboard) {
      await this.startDashboard();
    }
  }

  async stop(): Promise<void> {
    await this.stopDashboard();
    await this.stopRuntime();
  }

  async startRuntime(): Promise<void> {
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

  async startDashboard(): Promise<string> {
    if (this.dashboardInfo) {
      return this.dashboardInfo.url;
    }

    const [port, host] = this.resolveDashboardAddress();

    try {
      return await this.startDashboardServer(port, host);
    } catch (error) {
      if (!isAddressInUseError(error) || port === 0) {
        throw error;
      }

      this.logger.warn("dashboard port already in use; retrying with an ephemeral port", {
        host,
        requested_port: port
      });
      await this.disposeDashboardServer();
      return this.startDashboardServer(0, host);
    }
  }

  async stopDashboard(): Promise<void> {
    if (!this.statusServer) {
      return;
    }

    await this.statusServer.stop();
    this.statusServer = null;
    this.dashboardInfo = null;
    this.publishState();
  }

  snapshot(): StatusSnapshot {
    return this.runtime.snapshot();
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  subscribeState(listener: (state: AppControlState) => void): () => void {
    this.subscribers.add(listener);
    listener(this.state());
    return () => {
      this.subscribers.delete(listener);
    };
  }

  state(): AppControlState {
    return {
      runtimeRunning: this.runtimeRunning,
      dashboardRunning: this.dashboardInfo !== null,
      dashboardUrl: this.dashboardInfo?.url ?? null,
      projectsRoot: this.setupContextValue.projectsRoot,
      configuredWorkflowCount: this.knownWorkflowPaths.size
    };
  }

  async dashboardSetupContext(): Promise<DashboardSetupContext> {
    const globalConfig = await this.readGlobalConfig();
    this.setupContextValue.globalConfig = globalConfig;
    return {
      ...this.setupContextValue,
      globalConfig
    };
  }

  async readGlobalConfig(): Promise<GlobalConfigRecord> {
    return readGlobalConfig(this.workflowContext.projectsRoot, this.env);
  }

  async updateGlobalConfig(input: GlobalConfigInput): Promise<GlobalConfigRecord> {
    const next = await updateGlobalConfig(this.workflowContext.projectsRoot, input, this.env);
    this.setupContextValue.globalConfig = next;

    for (const workflowPath of this.knownWorkflowPaths) {
      await this.runtime.reloadWorkflow(workflowPath);
    }

    this.publishState();
    return next;
  }

  async listProjects(): Promise<ManagedProjectRecord[]> {
    const projects = await listProjectSetups([...this.knownWorkflowPaths], this.env, this.workflowContext.projectsRoot);
    return projects.map((project) => ({
      ...project,
      runtimeRunning: this.runtime.isWorkflowRunning(project.workflowPath)
    }));
  }

  async createProject(input: ProjectSetupInput): Promise<ProjectSetupResult> {
    const result = await createProjectSetup(this.workflowContext.projectsRoot, input, this.env);
    const workflowPath = path.resolve(result.workflowPath);
    this.knownWorkflowPaths.add(workflowPath);
    await this.runtime.addWorkflow(workflowPath);
    this.publishState();
    return {
      ...result,
      runtimeRunning: this.runtime.isWorkflowRunning(workflowPath)
    };
  }

  async updateProject(input: ProjectUpdateInput): Promise<ManagedProjectRecord> {
    const updated = await updateProjectSetup(input.id, input, this.env, this.workflowContext.projectsRoot);
    const previousPath = path.resolve(input.id);
    const nextPath = path.resolve(updated.workflowPath);
    if (previousPath !== nextPath) {
      this.knownWorkflowPaths.delete(previousPath);
    }
    this.knownWorkflowPaths.add(nextPath);
    await this.runtime.removeWorkflow(previousPath);
    await this.runtime.reloadWorkflow(nextPath);
    this.publishState();
    return {
      ...updated,
      runtimeRunning: this.runtime.isWorkflowRunning(nextPath)
    };
  }

  async removeProject(id: string): Promise<void> {
    const workflowPath = path.resolve(id);
    await this.runtime.removeWorkflow(workflowPath);
    this.knownWorkflowPaths.delete(workflowPath);
    await removeProjectSetup(workflowPath);
    this.publishState();
  }

  async startProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord> {
    const workflowPath = path.resolve(input.id);
    const updated = await setProjectEnabled(workflowPath, {
      ...input,
      enabled: true
    }, this.env, this.workflowContext.projectsRoot);
    this.knownWorkflowPaths.add(workflowPath);
    await this.runtime.enableWorkflow(workflowPath);
    this.runtimeRunning = true;
    this.publishState();
    return {
      ...updated,
      runtimeRunning: this.runtime.isWorkflowRunning(workflowPath)
    };
  }

  async stopProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord> {
    const workflowPath = path.resolve(input.id);
    const updated = await setProjectEnabled(workflowPath, {
      ...input,
      enabled: false
    }, this.env, this.workflowContext.projectsRoot);
    await this.runtime.disableWorkflow(workflowPath);
    this.publishState();
    return {
      ...updated,
      runtimeRunning: this.runtime.isWorkflowRunning(workflowPath)
    };
  }

  private resolveDashboardAddress(): [number, string] {
    const configured = this.runtime.dashboardConfig();
    const host = configured?.host ?? this.env.ORCHESTRAI_DASHBOARD_HOST ?? DEFAULT_DASHBOARD_HOST;
    const port = configured?.port ?? coerceDashboardPort(this.env.ORCHESTRAI_DASHBOARD_PORT);
    return [port, host];
  }

  private async startDashboardServer(port: number, host: string): Promise<string> {
    this.statusServer = new StatusServer(this, this.logger.child({ component: "status-server" }), this);
    this.dashboardInfo = await this.statusServer.start(port, host);
    this.publishState();
    return this.dashboardInfo.url;
  }

  private async disposeDashboardServer(): Promise<void> {
    if (!this.statusServer) {
      return;
    }

    await this.statusServer.stop().catch(() => undefined);
    this.statusServer = null;
    this.dashboardInfo = null;
    this.publishState();
  }

  private publishState(): void {
    const state = this.state();
    for (const subscriber of this.subscribers) {
      subscriber(state);
    }
  }
}

function coerceDashboardPort(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_DASHBOARD_PORT;
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}
