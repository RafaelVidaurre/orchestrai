import { startTransition, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Cog,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Shield,
  X
} from "lucide-react";

import type {
  DashboardBootstrap,
  DashboardSetupContext,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectSetupResult,
  StatusProjectSummary,
  StatusRetryEntry,
  StatusRunningEntry,
  StatusSnapshot
} from "./domain";

type ThemePreference = "system" | "light" | "dark";
type ConnectionState = "connecting" | "live" | "reconnecting" | "failed";
type SettingsTab = "global" | "project" | "create";
type StatusNotice = {
  kind: "idle" | "saving" | "success" | "error";
  message: string;
};
type GlobalFormState = {
  pollingIntervalMs: string;
  maxConcurrentAgents: string;
  linearApiKey: string;
  githubToken: string;
  clearLinearApiKey: boolean;
  clearGithubToken: boolean;
};
type ProjectFormState = {
  displayName: string;
  projectSlug: string;
  githubRepository: string;
  linearApiKey: string;
  githubToken: string;
  useGlobalLinearApiKey: boolean;
  useGlobalGithubToken: boolean;
  pollingIntervalMs: string;
  maxConcurrentAgents: string;
  useGlobalPollingIntervalMs: boolean;
  useGlobalMaxConcurrentAgents: boolean;
};

const themeStorageKey = "orchestrai-dashboard-theme";

declare global {
  interface Window {
    __ORCHESTRAI_BOOTSTRAP__?: DashboardBootstrap;
  }
}

function DashboardApp() {
  const bootstrap = window.__ORCHESTRAI_BOOTSTRAP__;
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(() => bootstrap?.initialSnapshot ?? null);
  const [setupContext, setSetupContext] = useState<DashboardSetupContext | null>(() => bootstrap?.setupContext ?? null);
  const [projects, setProjects] = useState<ManagedProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("global");
  const [globalFormState, setGlobalFormState] = useState<GlobalFormState>(() => emptyGlobalForm());
  const [projectFormState, setProjectFormState] = useState<ProjectFormState>(() => emptyProjectForm());
  const [createProjectFormState, setCreateProjectFormState] = useState<ProjectFormState>(() => emptyProjectForm());
  const [settingsNotice, setSettingsNotice] = useState<StatusNotice>({
    kind: "idle",
    message: "System settings live behind the cog. Project creation and overrides live in the settings sheet."
  });

  const effectiveSnapshot = snapshot ?? emptySnapshot();
  const globalConfig = setupContext?.globalConfig ?? emptyGlobalConfig();
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const selectedSnapshot = useMemo(
    () => filterSnapshotByProject(effectiveSnapshot, selectedProjectId),
    [effectiveSnapshot, selectedProjectId]
  );
  const selectedProjectSummary = useMemo(
    () => selectedSnapshot.projects[0] ?? null,
    [selectedSnapshot]
  );

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (setupContext) {
      setGlobalFormState(globalConfigToForm(setupContext.globalConfig));
    }
  }, [setupContext]);

  useEffect(() => {
    void refreshSetupContext(setSetupContext, setGlobalFormState);
    void refreshProjects(setProjects, setSelectedProjectId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    async function bootstrapSnapshot(): Promise<void> {
      if (!snapshot) {
        try {
          const nextSnapshot = await fetchJson<StatusSnapshot>("/api/snapshot");
          if (!cancelled) {
            startTransition(() => {
              setSnapshot(nextSnapshot);
              setConnectionState("connecting");
            });
          }
        } catch {
          if (!cancelled) {
            setConnectionState("failed");
          }
        }
      }

      source = new EventSource("/api/events");
      source.onopen = () => {
        if (!cancelled) {
          setConnectionState("live");
        }
      };
      source.addEventListener("snapshot", (event) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setSnapshot(JSON.parse(event.data) as StatusSnapshot);
          setConnectionState("live");
        });
      });
      source.onerror = () => {
        if (!cancelled) {
          setConnectionState("reconnecting");
        }
      };
    }

    void bootstrapSnapshot();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [snapshot]);

  useEffect(() => {
    if (!selectedProject) {
      setProjectFormState(emptyProjectForm());
      return;
    }

    setProjectFormState(projectToForm(selectedProject));
  }, [selectedProject]);

  const activeAgents = selectedSnapshot.running;
  const visibleProjects = selectedProject ? projects.filter((project) => project.id === selectedProject.id) : projects;

  return (
    <div className="app-shell">
      <aside className="project-rail">
        <div className="rail-stack">
          {projects.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <button
                key={project.id}
                type="button"
                className={joinClassName(
                  "project-pill",
                  selected ? "selected" : null,
                  project.runtimeRunning ? "running" : "stopped"
                )}
                aria-label={`${projectLabel(project)} (${projectRuntimeLabel(project)})`}
                title={`${projectLabel(project)} (${projectRuntimeLabel(project)})`}
                onClick={() => {
                  setSelectedProjectId(project.id);
                  setSettingsNotice({
                    kind: "idle",
                    message: "Operations focus updated. Use the cog to edit global settings or project overrides."
                  });
                }}
              >
                <span className="project-pill-indicator"></span>
                <span className="project-pill-face">
                  {projectInitial(project)}
                  <span className="project-pill-status" aria-hidden="true"></span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="rail-stack rail-footer">
          <button
            type="button"
            className="project-pill add"
            aria-label="Create project"
            title="Create project"
            onClick={() => {
              setCreateProjectFormState(emptyProjectForm());
              setSettingsTab("create");
              setSettingsOpen(true);
              setSettingsNotice({
                kind: "idle",
                message: "Create a project with only the repo and slug, then inherit the shared settings you already defined."
              });
            }}
          >
            <span className="project-pill-indicator"></span>
            <span className="project-pill-face">
              <Plus size={20} />
            </span>
          </button>
          <button
            type="button"
            className="project-pill chrome"
            aria-label="Open settings"
            title="Open settings"
            onClick={() => {
              setSettingsTab(selectedProject ? "project" : "global");
              setSettingsOpen(true);
            }}
          >
            <span className="project-pill-indicator"></span>
            <span className="project-pill-face">
              <Cog size={18} />
            </span>
          </button>
        </div>
      </aside>
      <main className="dashboard-main">
        <header className="topbar">
          <div className="topbar-copy">
            <div className="eyebrow">Operations</div>
            <h1>{selectedProject ? projectLabel(selectedProject) : "OrchestrAI Control Room"}</h1>
            <p>
              {selectedProject
                ? `${projectRuntimeSentence(selectedProject)} This surface stays focused on live work; settings live behind the cog.`
                : "Track agents, retries, and project throughput here. Shared defaults and per-project overrides are available in the settings sheet."}
            </p>
          </div>
          <div className="topbar-actions">
            <div className="badge">
              <span className="dot"></span>
              <span>{statusMessage(connectionState, snapshot)}</span>
            </div>
            <label className="theme-field">
              <span>Theme</span>
              <select
                aria-label="Theme preference"
                className="theme-select"
                value={themePreference}
                onChange={(event) => {
                  const nextPreference = event.target.value as ThemePreference;
                  writeThemePreference(nextPreference);
                  setThemePreference(nextPreference);
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <button
              type="button"
              className="ghost-button icon-only"
              aria-label="Open settings"
              title="Open settings"
              onClick={() => {
                setSettingsTab(selectedProject ? "project" : "global");
                setSettingsOpen(true);
              }}
            >
              <Cog size={16} />
            </button>
            {selectedProject ? (
              <button
                type="button"
                className={selectedProject.runtimeRunning ? "danger-button icon-button" : "primary-button icon-button"}
                onClick={() => {
                  void toggleProjectRuntime(
                    selectedProject,
                    selectedProject.runtimeRunning ? "stop" : "start",
                    setSettingsNotice,
                    setProjects,
                    setSelectedProjectId,
                    setProjectFormState
                  );
                }}
              >
                {selectedProject.runtimeRunning ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
                <span>{selectedProject.runtimeRunning ? "Stop Project" : "Start Project"}</span>
              </button>
            ) : null}
          </div>
        </header>

        <section className="hero-grid">
          <StatCard
            label="Active Agents"
            value={String(activeAgents.length)}
            hint={selectedProject ? "Filtered to the selected project" : "Across all running projects"}
            icon={<Activity size={16} />}
          />
          <StatCard
            label="Retry Queue"
            value={String(selectedSnapshot.retry_count)}
            hint={selectedProject ? "Selected project backoff queue" : "Projects waiting for another attempt"}
            icon={<RefreshCw size={16} />}
          />
          <StatCard
            label="Total Tokens"
            value={formatInteger(selectedSnapshot.codex_totals.totalTokens)}
            hint="Current focused scope"
            icon={<Shield size={16} />}
          />
          <StatCard
            label="Completed"
            value={String(selectedSnapshot.completed_count)}
            hint={selectedProject ? "Completed work in the selected project" : "Completed work across loaded projects"}
            icon={<CheckCircle2 size={16} />}
          />
        </section>

        <section className="content-grid">
          <SectionCard
            className="span-two"
            title="Active Agents"
            description="Long-running work should be legible at a glance: who is active, how long they have been alive, and the last meaningful thing they reported."
          >
            <AgentTable entries={activeAgents} />
          </SectionCard>
          <SectionCard
            title={selectedProject ? "Project Focus" : "Project Summary"}
            description={selectedProject ? "Current project status and inherited configuration posture." : "Use the left rail to narrow the view to a single project."}
          >
            <FocusPanel project={selectedProject} summary={selectedProjectSummary} globalConfig={globalConfig} />
          </SectionCard>
          <SectionCard
            className="span-two"
            title="Projects"
            description="Each card shows runtime state, effective defaults, and the project link."
          >
            <ProjectGrid projects={visibleProjects} summaries={selectedSnapshot.projects} />
          </SectionCard>
          <SectionCard title="Queued Retries" description="Backoff queue for work that needs another pass.">
            <RetryList entries={selectedSnapshot.retries} />
          </SectionCard>
          <SectionCard className="span-three" title="Recent Events" description="Operator-visible events from the orchestration loop.">
            <EventList events={selectedSnapshot.recent_events} />
          </SectionCard>
        </section>
      </main>

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        globalConfig={globalConfig}
        globalFormState={globalFormState}
        setGlobalFormState={setGlobalFormState}
        selectedProject={selectedProject}
        projectFormState={projectFormState}
        setProjectFormState={setProjectFormState}
        createProjectFormState={createProjectFormState}
        setCreateProjectFormState={setCreateProjectFormState}
        notice={settingsNotice}
        setNotice={setSettingsNotice}
        setProjects={setProjects}
        setSelectedProjectId={setSelectedProjectId}
        setSetupContext={setSetupContext}
      />
    </div>
  );
}

function SettingsSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  globalConfig: GlobalConfigRecord;
  globalFormState: GlobalFormState;
  setGlobalFormState: Dispatch<SetStateAction<GlobalFormState>>;
  selectedProject: ManagedProjectRecord | null;
  projectFormState: ProjectFormState;
  setProjectFormState: Dispatch<SetStateAction<ProjectFormState>>;
  createProjectFormState: ProjectFormState;
  setCreateProjectFormState: Dispatch<SetStateAction<ProjectFormState>>;
  notice: StatusNotice;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>;
}) {
  const {
    open,
    onOpenChange,
    tab,
    onTabChange,
    globalConfig,
    globalFormState,
    setGlobalFormState,
    selectedProject,
    projectFormState,
    setProjectFormState,
    createProjectFormState,
    setCreateProjectFormState,
    notice,
    setNotice,
    setProjects,
    setSelectedProjectId,
    setSetupContext
  } = props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content">
          <div className="sheet-header">
            <div>
              <Dialog.Title className="sheet-title">Settings</Dialog.Title>
              <Dialog.Description className="sheet-description">
                Shared defaults and secrets live under global settings. Project tabs only store local overrides.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="ghost-button icon-only" aria-label="Close settings">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <Tabs.Root value={tab} onValueChange={(value) => onTabChange(value as SettingsTab)}>
            <Tabs.List className="settings-tabs">
              <Tabs.Trigger className="settings-tab" value="global">
                Global
              </Tabs.Trigger>
              <Tabs.Trigger className="settings-tab" value="project" disabled={!selectedProject}>
                Project
              </Tabs.Trigger>
              <Tabs.Trigger className="settings-tab" value="create">
                New Project
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content className="settings-panel" value="global">
              <section className="settings-section">
                <h2>Global defaults</h2>
                <p>These values become the shared baseline for new projects and for any project field currently inheriting.</p>
                <form
                  className="settings-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveGlobalSettings({
                      formState: globalFormState,
                      setNotice,
                      setSetupContext,
                      setGlobalFormState,
                      setProjects,
                      setSelectedProjectId
                    });
                  }}
                >
                  <div className="field-grid">
                    <Field label="Default polling interval (ms)" help="Used when a project does not override polling.">
                      <input
                        value={globalFormState.pollingIntervalMs}
                        onChange={(event) => {
                          setGlobalFormState((current) => ({ ...current, pollingIntervalMs: event.target.value }));
                        }}
                      />
                    </Field>
                    <Field label="Default max concurrent agents" help="Used when a project does not override concurrency.">
                      <input
                        value={globalFormState.maxConcurrentAgents}
                        onChange={(event) => {
                          setGlobalFormState((current) => ({ ...current, maxConcurrentAgents: event.target.value }));
                        }}
                      />
                    </Field>
                    <Field
                      className="full"
                      label={`Shared Linear API key ${globalConfig.hasLinearApiKey ? "(leave blank to keep current)" : ""}`}
                      help="Projects can inherit this key instead of storing a local override."
                    >
                      <input
                        type="password"
                        value={globalFormState.linearApiKey}
                        placeholder={globalConfig.hasLinearApiKey ? "Keep existing shared Linear key" : "lin_api_..."}
                        onChange={(event) => {
                          setGlobalFormState((current) => ({
                            ...current,
                            linearApiKey: event.target.value,
                            clearLinearApiKey: false
                          }));
                        }}
                      />
                    </Field>
                    <Field
                      className="full"
                      label={`Shared GitHub token ${globalConfig.hasGithubToken ? "(leave blank to keep current)" : "(optional)"}`}
                      help="Used for private HTTPS clones when a project does not store its own override."
                    >
                      <input
                        type="password"
                        value={globalFormState.githubToken}
                        placeholder={globalConfig.hasGithubToken ? "Keep existing shared GitHub token" : "Optional"}
                        onChange={(event) => {
                          setGlobalFormState((current) => ({
                            ...current,
                            githubToken: event.target.value,
                            clearGithubToken: false
                          }));
                        }}
                      />
                    </Field>
                  </div>
                  <div className="toggle-stack">
                    {globalConfig.hasLinearApiKey ? (
                      <ToggleRow
                        checked={globalFormState.clearLinearApiKey}
                        label="Clear shared Linear API key"
                        onCheckedChange={(checked) => {
                          setGlobalFormState((current) => ({
                            ...current,
                            clearLinearApiKey: checked,
                            linearApiKey: checked ? "" : current.linearApiKey
                          }));
                        }}
                      />
                    ) : null}
                    {globalConfig.hasGithubToken ? (
                      <ToggleRow
                        checked={globalFormState.clearGithubToken}
                        label="Clear shared GitHub token"
                        onCheckedChange={(checked) => {
                          setGlobalFormState((current) => ({
                            ...current,
                            clearGithubToken: checked,
                            githubToken: checked ? "" : current.githubToken
                          }));
                        }}
                      />
                    ) : null}
                  </div>
                  <FormFooter notice={notice}>
                    <button className="primary-button" type="submit" disabled={notice.kind === "saving"}>
                      Save Global Settings
                    </button>
                  </FormFooter>
                </form>
              </section>
            </Tabs.Content>

            <Tabs.Content className="settings-panel" value="project">
              {selectedProject ? (
                <section className="settings-section">
                  <h2>{projectLabel(selectedProject)}</h2>
                  <p>Project fields only store local overrides. Turn an override off to fall back to the shared global value.</p>
                  <ProjectSettingsForm
                    mode="update"
                    formState={projectFormState}
                    setFormState={setProjectFormState}
                    selectedProject={selectedProject}
                    globalConfig={globalConfig}
                    notice={notice}
                    setNotice={setNotice}
                    setProjects={setProjects}
                    setSelectedProjectId={setSelectedProjectId}
                  />
                </section>
              ) : (
                <EmptyPanel message="Select a project from the left rail to edit project-specific overrides." />
              )}
            </Tabs.Content>

            <Tabs.Content className="settings-panel" value="create">
              <section className="settings-section">
                <h2>Create Project</h2>
                <p>Only the slug and GitHub repository are strictly required here when you already have a shared Linear key in global settings.</p>
                <ProjectSettingsForm
                  mode="create"
                  formState={createProjectFormState}
                  setFormState={setCreateProjectFormState}
                  selectedProject={null}
                  globalConfig={globalConfig}
                  notice={notice}
                  setNotice={setNotice}
                  setProjects={setProjects}
                  setSelectedProjectId={setSelectedProjectId}
                />
              </section>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProjectSettingsForm(props: {
  mode: "create" | "update";
  formState: ProjectFormState;
  setFormState: Dispatch<SetStateAction<ProjectFormState>>;
  selectedProject: ManagedProjectRecord | null;
  globalConfig: GlobalConfigRecord;
  notice: StatusNotice;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
}) {
  const { mode, formState, setFormState, selectedProject, globalConfig, notice, setNotice, setProjects, setSelectedProjectId } = props;
  const actionLabel = mode === "create" ? "Create Project" : "Save Project";

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void saveProject({
          mode,
          selectedProject,
          formState,
          setNotice,
          setProjects,
          setSelectedProjectId
        });
      }}
    >
      <div className="field-grid">
        <Field label="Project name" help="Human-readable display name used across the dashboard and TUI.">
          <input
            value={formState.displayName}
            placeholder="Optional display name"
            onChange={(event) => {
              setFormState((current) => ({ ...current, displayName: event.target.value }));
            }}
          />
        </Field>
        <Field label="Linear project slug" help="This is the only project-specific Linear identifier required.">
          <input
            value={formState.projectSlug}
            placeholder="project-abc123"
            onChange={(event) => {
              setFormState((current) => ({ ...current, projectSlug: event.target.value }));
            }}
          />
        </Field>
        <Field className="full" label="GitHub repository" help="Use owner/repo or a GitHub URL.">
          <input
            value={formState.githubRepository}
            placeholder="owner/repo"
            onChange={(event) => {
              setFormState((current) => ({ ...current, githubRepository: event.target.value }));
            }}
          />
        </Field>

        <Field
          className="full"
          label={`Linear API key ${selectedProject?.hasLinearApiKey ? "(leave blank to keep local override)" : ""}`}
          help={formState.useGlobalLinearApiKey ? "This project inherits the shared Linear key." : "Set a project-local override or keep the current local value."}
        >
          <input
            type="password"
            value={formState.linearApiKey}
            placeholder={formState.useGlobalLinearApiKey ? "Using shared Linear API key" : "Optional local override"}
            disabled={formState.useGlobalLinearApiKey}
            onChange={(event) => {
              setFormState((current) => ({ ...current, linearApiKey: event.target.value }));
            }}
          />
        </Field>
        {globalConfig.hasLinearApiKey ? (
          <ToggleRow
            checked={formState.useGlobalLinearApiKey}
            label="Use shared Linear API key"
            onCheckedChange={(checked) => {
              setFormState((current) => ({ ...current, useGlobalLinearApiKey: checked }));
            }}
          />
        ) : null}

        <Field
          className="full"
          label={`GitHub token ${selectedProject?.hasGithubToken ? "(leave blank to keep local override)" : "(optional)"}`}
          help={formState.useGlobalGithubToken ? "This project inherits the shared GitHub token." : "Set a project-local override when this repo needs private HTTPS clone auth."}
        >
          <input
            type="password"
            value={formState.githubToken}
            placeholder={formState.useGlobalGithubToken ? "Using shared GitHub token" : "Optional local override"}
            disabled={formState.useGlobalGithubToken}
            onChange={(event) => {
              setFormState((current) => ({ ...current, githubToken: event.target.value }));
            }}
          />
        </Field>
        {globalConfig.hasGithubToken ? (
          <ToggleRow
            checked={formState.useGlobalGithubToken}
            label="Use shared GitHub token"
            onCheckedChange={(checked) => {
              setFormState((current) => ({ ...current, useGlobalGithubToken: checked }));
            }}
          />
        ) : null}

        <Field
          label="Polling interval (ms)"
          help={formState.useGlobalPollingIntervalMs ? `Using shared default (${globalConfig.defaults.pollingIntervalMs}ms)` : "Project-local override"}
        >
          <input
            value={formState.pollingIntervalMs}
            disabled={formState.useGlobalPollingIntervalMs}
            placeholder={String(globalConfig.defaults.pollingIntervalMs)}
            onChange={(event) => {
              setFormState((current) => ({ ...current, pollingIntervalMs: event.target.value }));
            }}
          />
        </Field>
        <Field
          label="Max concurrent agents"
          help={formState.useGlobalMaxConcurrentAgents ? `Using shared default (${globalConfig.defaults.maxConcurrentAgents})` : "Project-local override"}
        >
          <input
            value={formState.maxConcurrentAgents}
            disabled={formState.useGlobalMaxConcurrentAgents}
            placeholder={String(globalConfig.defaults.maxConcurrentAgents)}
            onChange={(event) => {
              setFormState((current) => ({ ...current, maxConcurrentAgents: event.target.value }));
            }}
          />
        </Field>

        <ToggleRow
          checked={formState.useGlobalPollingIntervalMs}
          label="Use shared polling interval"
          onCheckedChange={(checked) => {
            setFormState((current) => ({ ...current, useGlobalPollingIntervalMs: checked }));
          }}
        />
        <ToggleRow
          checked={formState.useGlobalMaxConcurrentAgents}
          label="Use shared max concurrency"
          onCheckedChange={(checked) => {
            setFormState((current) => ({ ...current, useGlobalMaxConcurrentAgents: checked }));
          }}
        />
      </div>

      <FormFooter notice={notice}>
        <button className="primary-button" type="submit" disabled={notice.kind === "saving"}>
          {actionLabel}
        </button>
        {mode === "update" && selectedProject ? (
          <>
            <button
              className={selectedProject.runtimeRunning ? "danger-button" : "secondary-button"}
              type="button"
              disabled={notice.kind === "saving"}
              onClick={() => {
                void toggleProjectRuntime(
                  selectedProject,
                  selectedProject.runtimeRunning ? "stop" : "start",
                  setNotice,
                  setProjects,
                  setSelectedProjectId
                );
              }}
            >
              {selectedProject.runtimeRunning ? "Stop Project" : "Start Project"}
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={notice.kind === "saving"}
              onClick={() => {
                void deleteProject(selectedProject, setNotice, setProjects, setSelectedProjectId);
              }}
            >
              Remove Project
            </button>
          </>
        ) : null}
      </FormFooter>
    </form>
  );
}

function StatCard(props: { label: string; value: string; hint: string; icon: ReactNode }) {
  return (
    <article className="stat-card">
      <div className="stat-head">
        <span>{props.label}</span>
        <span className="stat-icon">{props.icon}</span>
      </div>
      <div className="stat-value">{props.value}</div>
      <p>{props.hint}</p>
    </article>
  );
}

function SectionCard(props: {
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={joinClassName("section-card", props.className)}>
      <div className="section-head">
        <div>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function AgentTable(props: { entries: StatusRunningEntry[] }) {
  if (props.entries.length === 0) {
    return <EmptyPanel message="No active agents right now." />;
  }

  return (
    <div className="table-wrap">
      <table className="shad-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Project</th>
            <th>State</th>
            <th>Runtime</th>
            <th>Tokens</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={`${entry.workflow_path}:${entry.issue_id}`}>
              <td>
                <div className="table-primary">
                  {entry.issue_url ? (
                    <a href={entry.issue_url} target="_blank" rel="noreferrer">
                      {entry.identifier}
                    </a>
                  ) : (
                    entry.identifier
                  )}
                </div>
                <div className="table-secondary">{entry.title}</div>
              </td>
              <td>{entry.project_name ?? entry.project_slug}</td>
              <td>
                <span className="inline-chip">{entry.state}</span>
              </td>
              <td>{formatDurationFromMs(Date.now() - entry.started_at_ms)}</td>
              <td>{formatInteger(entry.codex_total_tokens)}</td>
              <td>{shortActivity(entry.activity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RetryList(props: { entries: StatusRetryEntry[] }) {
  if (props.entries.length === 0) {
    return <EmptyPanel message="No queued retries." />;
  }

  return (
    <div className="stack-list">
      {props.entries.slice(0, 8).map((entry) => (
        <article className="stack-item" key={`${entry.workflow_path}:${entry.issue_id}`}>
          <div className="stack-item-head">
            <strong>{entry.identifier}</strong>
            <span>{entry.project_name ?? entry.project_slug}</span>
          </div>
          <div className="table-secondary">{entry.title}</div>
          <div className="stack-meta">attempt {entry.attempt} • due {formatRelativeTime(entry.due_at_ms)}</div>
          <div className="stack-meta">{entry.error ?? "Waiting for next retry window"}</div>
        </article>
      ))}
    </div>
  );
}

function EventList(props: { events: StatusSnapshot["recent_events"] }) {
  if (props.events.length === 0) {
    return <EmptyPanel message="No orchestration events yet." />;
  }

  return (
    <div className="stack-list">
      {props.events.slice(0, 10).map((event, index) => (
        <article className="stack-item" key={`${event.timestamp}:${index}`}>
          <div className="stack-item-head">
            <strong>{event.message}</strong>
            <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
          </div>
          <div className="stack-meta">
            {event.level.toUpperCase()}
            {event.issueIdentifier ? ` • ${event.issueIdentifier}` : ""}
          </div>
        </article>
      ))}
    </div>
  );
}

function ProjectGrid(props: { projects: ManagedProjectRecord[]; summaries: StatusProjectSummary[] }) {
  if (props.projects.length === 0) {
    return <EmptyPanel message="No configured projects yet. Use the plus button in the rail to add one." />;
  }

  const summaryById = new Map(props.summaries.map((summary) => [summary.workflow_path, summary]));
  return (
    <div className="project-grid">
      {props.projects.map((project) => {
        const summary = summaryById.get(project.id);
        return (
          <article className="project-summary-card" key={project.id}>
            <div className="project-card-head">
              <div>
                <h3>{projectLabel(project)}</h3>
                <p>{project.githubRepository ?? "No repository configured"}</p>
              </div>
              <span className={project.runtimeRunning ? "status-pill live" : "status-pill idle"}>
                {project.runtimeRunning ? "Running" : "Stopped"}
              </span>
            </div>
            <div className="summary-facts">
              <SummaryFact label="Linear slug" value={project.projectSlug} />
              <SummaryFact
                label="Defaults"
                value={`${project.usesGlobalPollingIntervalMs ? "global" : `${project.pollingIntervalMs}ms`} / ${
                  project.usesGlobalMaxConcurrentAgents ? "global" : project.maxConcurrentAgents
                }`}
              />
              <SummaryFact label="Agents" value={summary ? String(summary.running_count) : "0"} />
              <SummaryFact label="Queued" value={summary ? String(summary.retry_count) : "0"} />
            </div>
            {summary?.linear_project.url ? (
              <a className="inline-link" href={summary.linear_project.url} target="_blank" rel="noreferrer">
                Open Linear project
                <ArrowUpRight size={14} />
              </a>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function FocusPanel(props: {
  project: ManagedProjectRecord | null;
  summary: StatusProjectSummary | null;
  globalConfig: GlobalConfigRecord;
}) {
  if (!props.project) {
    return (
      <div className="stack-list">
        <article className="stack-item">
          <div className="stack-item-head">
            <strong>Global defaults</strong>
            <span>{props.globalConfig.defaults.pollingIntervalMs}ms / {props.globalConfig.defaults.maxConcurrentAgents}</span>
          </div>
          <div className="stack-meta">
            Shared Linear key {props.globalConfig.hasLinearApiKey ? "present" : "missing"} • Shared GitHub token{" "}
            {props.globalConfig.hasGithubToken ? "present" : "missing"}
          </div>
        </article>
        <article className="stack-item">
          <div className="stack-item-head">
            <strong>Select a project</strong>
          </div>
          <div className="stack-meta">The rail keeps the main canvas focused. Settings stay out of the way until you need them.</div>
        </article>
      </div>
    );
  }

  return (
    <div className="stack-list">
      <article className="stack-item">
        <div className="stack-item-head">
          <strong>{projectLabel(props.project)}</strong>
          <span>{projectRuntimeLabel(props.project)}</span>
        </div>
        <div className="stack-meta">
          {props.project.usesGlobalLinearApiKey ? "Shared Linear key" : "Local Linear override"} •{" "}
          {props.project.usesGlobalGithubToken ? "Shared GitHub token" : "Local GitHub override"}
        </div>
      </article>
      <article className="stack-item">
        <div className="stack-item-head">
          <strong>Effective defaults</strong>
          <span>
            {props.project.pollingIntervalMs}ms / {props.project.maxConcurrentAgents}
          </span>
        </div>
        <div className="stack-meta">
          Polling {props.project.usesGlobalPollingIntervalMs ? "inherits global default" : "overridden locally"} • Concurrency{" "}
          {props.project.usesGlobalMaxConcurrentAgents ? "inherits global default" : "overridden locally"}
        </div>
      </article>
      <article className="stack-item">
        <div className="stack-item-head">
          <strong>Live state</strong>
          <span>{props.summary ? `${props.summary.running_count} agents` : "Stopped"}</span>
        </div>
        <div className="stack-meta">
          {props.summary
            ? `${props.summary.retry_count} queued retries • ${formatInteger(props.summary.codex_totals.totalTokens)} total tokens`
            : "No live snapshot for this project right now"}
        </div>
      </article>
    </div>
  );
}

function SummaryFact(props: { label: string; value: string }) {
  return (
    <div className="summary-fact">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Field(props: { label: string; help: string; className?: string; children: ReactNode }) {
  return (
    <label className={joinClassName("field", props.className)}>
      <span>{props.label}</span>
      {props.children}
      <small>{props.help}</small>
    </label>
  );
}

function ToggleRow(props: { checked: boolean; label: string; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onCheckedChange(event.target.checked);
        }}
      />
      <span>{props.label}</span>
    </label>
  );
}

function FormFooter(props: { notice: StatusNotice; children: React.ReactNode }) {
  return (
    <div className="form-footer">
      <div className={joinClassName("notice", props.notice.kind === "error" ? "error" : null)}>{props.notice.message}</div>
      <div className="button-row">{props.children}</div>
    </div>
  );
}

function EmptyPanel(props: { message: string }) {
  return <div className="empty-panel">{props.message}</div>;
}

async function refreshSetupContext(
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>,
  setGlobalFormState: Dispatch<SetStateAction<GlobalFormState>>
): Promise<void> {
  const context = await fetchJson<DashboardSetupContext>("/api/setup/context");
  setSetupContext(context);
  setGlobalFormState(globalConfigToForm(context.globalConfig));
}

async function refreshProjects(
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>,
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>
): Promise<void> {
  const nextProjects = await fetchJson<ManagedProjectRecord[]>("/api/projects");
  setProjects(nextProjects);
  setSelectedProjectId((current) => {
    if (current && nextProjects.some((project) => project.id === current)) {
      return current;
    }
    return nextProjects[0]?.id ?? null;
  });
}

async function saveGlobalSettings(params: {
  formState: GlobalFormState;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>;
  setGlobalFormState: Dispatch<SetStateAction<GlobalFormState>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  const { formState, setNotice, setSetupContext, setGlobalFormState, setProjects, setSelectedProjectId } = params;
  setNotice({
    kind: "saving",
    message: "Saving shared defaults and reloading project runtimes..."
  });

  try {
    const globalConfig = await fetchJson<GlobalConfigRecord>("/api/settings/global", {
      method: "PATCH",
      body: JSON.stringify({
        pollingIntervalMs: parseNumberField(formState.pollingIntervalMs),
        maxConcurrentAgents: parseNumberField(formState.maxConcurrentAgents),
        linearApiKey: normalizeOptional(formState.linearApiKey),
        githubToken: normalizeOptional(formState.githubToken),
        clearLinearApiKey: formState.clearLinearApiKey,
        clearGithubToken: formState.clearGithubToken
      })
    });

    await refreshSetupContext(setSetupContext, setGlobalFormState);
    await refreshProjects(setProjects, setSelectedProjectId);
    setNotice({
      kind: "success",
      message: `Saved shared defaults (${globalConfig.defaults.pollingIntervalMs}ms, ${globalConfig.defaults.maxConcurrentAgents} agents)`
    });
  } catch (error) {
    setNotice({
      kind: "error",
      message: error instanceof Error ? error.message : "Failed to save global settings"
    });
  }
}

async function saveProject(params: {
  mode: "create" | "update";
  selectedProject: ManagedProjectRecord | null;
  formState: ProjectFormState;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  const { mode, selectedProject, formState, setNotice, setProjects, setSelectedProjectId } = params;
  setNotice({
    kind: "saving",
    message: mode === "create" ? "Creating project and activating workflow..." : "Saving project overrides..."
  });

  try {
    if (mode === "update" && selectedProject) {
      const updated = await fetchJson<ManagedProjectRecord>("/api/projects", {
        method: "PATCH",
        body: JSON.stringify({
          id: selectedProject.id,
          displayName: normalizeOptional(formState.displayName),
          projectSlug: formState.projectSlug,
          githubRepository: formState.githubRepository,
          linearApiKey: normalizeOptional(formState.linearApiKey),
          githubToken: normalizeOptional(formState.githubToken),
          pollingIntervalMs: formState.useGlobalPollingIntervalMs ? null : parseNumberField(formState.pollingIntervalMs),
          maxConcurrentAgents: formState.useGlobalMaxConcurrentAgents ? null : parseNumberField(formState.maxConcurrentAgents),
          useGlobalLinearApiKey: formState.useGlobalLinearApiKey,
          useGlobalGithubToken: formState.useGlobalGithubToken,
          useGlobalPollingIntervalMs: formState.useGlobalPollingIntervalMs,
          useGlobalMaxConcurrentAgents: formState.useGlobalMaxConcurrentAgents
        })
      });

      await refreshProjects(setProjects, setSelectedProjectId);
      setSelectedProjectId(updated.id);
      setNotice({
        kind: "success",
        message: `Saved ${projectLabel(updated)}`
      });
      return;
    }

    const created = await fetchJson<ProjectSetupResult>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        displayName: normalizeOptional(formState.displayName),
        projectSlug: formState.projectSlug,
        githubRepository: formState.githubRepository,
        linearApiKey: normalizeOptional(formState.linearApiKey),
        githubToken: normalizeOptional(formState.githubToken),
        pollingIntervalMs: formState.useGlobalPollingIntervalMs ? null : parseNumberField(formState.pollingIntervalMs),
        maxConcurrentAgents: formState.useGlobalMaxConcurrentAgents ? null : parseNumberField(formState.maxConcurrentAgents),
        useGlobalLinearApiKey: formState.useGlobalLinearApiKey,
        useGlobalGithubToken: formState.useGlobalGithubToken,
        useGlobalPollingIntervalMs: formState.useGlobalPollingIntervalMs,
        useGlobalMaxConcurrentAgents: formState.useGlobalMaxConcurrentAgents
      })
    });

    await refreshProjects(setProjects, setSelectedProjectId);
    setSelectedProjectId(created.id);
    setNotice({
      kind: "success",
      message: `Created ${projectLabel(created)}`
    });
  } catch (error) {
    setNotice({
      kind: "error",
      message: error instanceof Error ? error.message : "Project setup failed"
    });
  }
}

async function deleteProject(
  project: ManagedProjectRecord,
  setNotice: Dispatch<SetStateAction<StatusNotice>>,
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>,
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>
): Promise<void> {
  if (!window.confirm(`Remove ${projectLabel(project)}? This deletes the workflow directory and local overrides for this project.`)) {
    return;
  }

  setNotice({
    kind: "saving",
    message: `Removing ${projectLabel(project)}...`
  });

  try {
    await fetchJson("/api/projects", {
      method: "DELETE",
      body: JSON.stringify({ id: project.id })
    });
    await refreshProjects(setProjects, setSelectedProjectId);
    setNotice({
      kind: "success",
      message: `Removed ${projectLabel(project)}`
    });
  } catch (error) {
    setNotice({
      kind: "error",
      message: error instanceof Error ? error.message : "Failed to remove project"
    });
  }
}

async function toggleProjectRuntime(
  project: ManagedProjectRecord,
  action: "start" | "stop",
  setNotice: Dispatch<SetStateAction<StatusNotice>>,
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>,
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>,
  setProjectFormState?: Dispatch<SetStateAction<ProjectFormState>>
): Promise<void> {
  setNotice({
    kind: "saving",
    message: `${action === "start" ? "Starting" : "Stopping"} ${projectLabel(project)}...`
  });

  try {
    const updated = await fetchJson<ManagedProjectRecord>(`/api/projects/${action}`, {
      method: "POST",
      body: JSON.stringify({ id: project.id })
    });
    await refreshProjects(setProjects, setSelectedProjectId);
    setSelectedProjectId(updated.id);
    if (setProjectFormState) {
      setProjectFormState(projectToForm(updated));
    }
    setNotice({
      kind: "success",
      message: `${action === "start" ? "Started" : "Stopped"} ${projectLabel(updated)}`
    });
  } catch (error) {
    setNotice({
      kind: "error",
      message: error instanceof Error ? error.message : `Failed to ${action} project`
    });
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

function emptySnapshot(): StatusSnapshot {
  return {
    updated_at: new Date(0).toISOString(),
    project_count: 0,
    running_count: 0,
    retry_count: 0,
    completed_count: 0,
    claimed_count: 0,
    projects: [],
    running: [],
    retries: [],
    codex_totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0
    },
    recent_events: []
  };
}

function emptyGlobalConfig(): GlobalConfigRecord {
  return {
    projectsRoot: "",
    envFilePath: "",
    defaults: {
      pollingIntervalMs: 30000,
      maxConcurrentAgents: 10
    },
    hasLinearApiKey: false,
    hasGithubToken: false
  };
}

function emptyGlobalForm(): GlobalFormState {
  return {
    pollingIntervalMs: "30000",
    maxConcurrentAgents: "10",
    linearApiKey: "",
    githubToken: "",
    clearLinearApiKey: false,
    clearGithubToken: false
  };
}

function emptyProjectForm(): ProjectFormState {
  return {
    displayName: "",
    projectSlug: "",
    githubRepository: "",
    linearApiKey: "",
    githubToken: "",
    useGlobalLinearApiKey: true,
    useGlobalGithubToken: true,
    pollingIntervalMs: "",
    maxConcurrentAgents: "",
    useGlobalPollingIntervalMs: true,
    useGlobalMaxConcurrentAgents: true
  };
}

function globalConfigToForm(globalConfig: GlobalConfigRecord): GlobalFormState {
  return {
    pollingIntervalMs: String(globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: String(globalConfig.defaults.maxConcurrentAgents),
    linearApiKey: "",
    githubToken: "",
    clearLinearApiKey: false,
    clearGithubToken: false
  };
}

function projectToForm(project: ManagedProjectRecord): ProjectFormState {
  return {
    displayName: project.displayName ?? "",
    projectSlug: project.projectSlug,
    githubRepository: project.githubRepository ?? "",
    linearApiKey: "",
    githubToken: "",
    useGlobalLinearApiKey: project.usesGlobalLinearApiKey,
    useGlobalGithubToken: project.usesGlobalGithubToken,
    pollingIntervalMs: project.usesGlobalPollingIntervalMs ? "" : String(project.pollingIntervalMs),
    maxConcurrentAgents: project.usesGlobalMaxConcurrentAgents ? "" : String(project.maxConcurrentAgents),
    useGlobalPollingIntervalMs: project.usesGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents: project.usesGlobalMaxConcurrentAgents
  };
}

function filterSnapshotByProject(snapshot: StatusSnapshot, projectId: string | null): StatusSnapshot {
  if (!projectId) {
    return snapshot;
  }

  const projects = snapshot.projects.filter((project) => project.workflow_path === projectId);
  const running = snapshot.running.filter((entry) => entry.workflow_path === projectId);
  const retries = snapshot.retries.filter((entry) => entry.workflow_path === projectId);
  return {
    ...snapshot,
    project_count: projects.length,
    running_count: running.length,
    retry_count: retries.length,
    completed_count: projects.reduce((sum, project) => sum + project.completed_count, 0),
    claimed_count: projects.reduce((sum, project) => sum + project.claimed_count, 0),
    projects,
    running,
    retries,
    codex_totals: projects.reduce(
      (totals, project) => {
        totals.inputTokens += project.codex_totals.inputTokens;
        totals.outputTokens += project.codex_totals.outputTokens;
        totals.totalTokens += project.codex_totals.totalTokens;
        totals.secondsRunning += project.codex_totals.secondsRunning;
        return totals;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0
      }
    )
  };
}

function statusMessage(connectionState: ConnectionState, snapshot: StatusSnapshot | null): string {
  if (connectionState === "failed" && !snapshot) {
    return "Failed to load snapshot";
  }

  if (connectionState === "reconnecting") {
    return snapshot ? `Reconnecting… last update ${formatSnapshotTime(snapshot)}` : "Reconnecting…";
  }

  if (connectionState === "live") {
    return snapshot ? `Live at ${formatSnapshotTime(snapshot)}` : "Live";
  }

  return snapshot ? `Connecting… last update ${formatSnapshotTime(snapshot)}` : "Connecting…";
}

function formatSnapshotTime(snapshot: StatusSnapshot): string {
  return new Date(snapshot.updated_at).toLocaleTimeString();
}

function formatDurationFromMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function formatRelativeTime(targetMs: number): string {
  const delta = Math.max(0, targetMs - Date.now());
  return formatDurationFromMs(delta);
}

function shortActivity(value: string): string {
  if (value.length <= 96) {
    return value;
  }

  return `${value.slice(0, 93)}…`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function normalizeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumberField(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem(themeStorageKey);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function writeThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    window.localStorage.removeItem(themeStorageKey);
    return;
  }

  window.localStorage.setItem(themeStorageKey, preference);
}

function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
    return;
  }

  root.setAttribute("data-theme", preference);
}

function projectInitial(project: Pick<ManagedProjectRecord, "displayName" | "projectSlug">): string {
  const label = projectLabel(project);
  return label.slice(0, 1).toUpperCase();
}

function projectLabel(project: Pick<ManagedProjectRecord | ProjectSetupResult, "displayName" | "projectSlug">): string {
  return project.displayName ?? project.projectSlug;
}

function projectRuntimeLabel(project: Pick<ManagedProjectRecord, "enabled" | "runtimeRunning">): string {
  if (project.runtimeRunning) {
    return "running";
  }

  return project.enabled ? "ready" : "stopped";
}

function projectRuntimeSentence(project: Pick<ManagedProjectRecord, "enabled" | "runtimeRunning">): string {
  if (project.runtimeRunning) {
    return "This project is live in the current process.";
  }
  if (project.enabled) {
    return "This project is configured but not currently executing.";
  }
  return "This project is deliberately paused and will stay idle until started again.";
}

function joinClassName(...tokens: Array<string | null | undefined | false>): string {
  return tokens.filter(Boolean).join(" ");
}

const container = document.getElementById("app");
if (!container) {
  throw new Error("Dashboard root element was not found");
}

createRoot(container).render(<DashboardApp />);
