import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Cog,
  FolderGit2,
  Minus,
  MoonStar,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Settings2,
  SunMedium,
  Trash2
} from "lucide-react";

import type {
  DashboardBootstrap,
  DashboardSetupContext,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  StatusRetryEntry,
  StatusRunningEntry,
  StatusSnapshot
} from "./domain";
import { formatElapsedShort } from "./tui-layout";

type ThemePreference = "system" | "light" | "dark";
type ConnectionState = "connecting" | "live" | "reconnecting" | "failed";
type SettingsMode = "global" | "project" | "create" | null;
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
  const [settingsMode, setSettingsMode] = useState<SettingsMode>(null);
  const [globalFormState, setGlobalFormState] = useState<GlobalFormState>(() => emptyGlobalForm());
  const [projectFormState, setProjectFormState] = useState<ProjectFormState>(() => emptyProjectForm());
  const [createProjectFormState, setCreateProjectFormState] = useState<ProjectFormState>(() => emptyProjectForm());
  const [notice, setNotice] = useState<StatusNotice>(idleNotice());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sourceRef = useRef<EventSource | null>(null);

  const effectiveSnapshot = snapshot ?? emptySnapshot();
  const globalConfig = setupContext?.globalConfig ?? emptyGlobalConfig();
  const summaries = useMemo(() => {
    return new Map(effectiveSnapshot.projects.map((project) => [project.workflow_path, project] as const));
  }, [effectiveSnapshot.projects]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const selectedSnapshot = useMemo(
    () => filterSnapshotByProject(effectiveSnapshot, selectedProjectId),
    [effectiveSnapshot, selectedProjectId]
  );
  const activeAgents = useMemo(() => sortRunningEntries(selectedSnapshot.running), [selectedSnapshot.running]);
  const queuedRetries = useMemo(() => sortRetryEntries(selectedSnapshot.retries), [selectedSnapshot.retries]);
  const selectedProjectSummary = selectedProject ? summaries.get(selectedProject.workflowPath) ?? null : null;

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (setupContext) {
      setGlobalFormState(globalConfigToForm(setupContext.globalConfig));
    }
  }, [setupContext]);

  useEffect(() => {
    if (!selectedProject) {
      setProjectFormState(emptyProjectForm());
      return;
    }

    setProjectFormState(projectToForm(selectedProject));
  }, [selectedProject]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    void refreshSetupContext(setSetupContext, setGlobalFormState);
    void refreshProjects(setProjects, setSelectedProjectId);

    if (!snapshot) {
      void fetchJson<StatusSnapshot>("/api/snapshot")
        .then((nextSnapshot) => {
          if (!active) {
            return;
          }
          startTransition(() => {
            setSnapshot(nextSnapshot);
          });
        })
        .catch(() => {
          if (active) {
            setConnectionState("failed");
          }
        });
    }

    const source = new EventSource("/api/events");
    sourceRef.current = source;
    source.onopen = () => {
      if (!active) {
        return;
      }

      setConnectionState("live");
    };
    source.addEventListener("snapshot", (event) => {
      if (!active) {
        return;
      }

      startTransition(() => {
        setSnapshot(JSON.parse(event.data) as StatusSnapshot);
        setConnectionState("live");
      });
    });
    source.addEventListener("heartbeat", () => {
      if (active) {
        setConnectionState((current) => (current === "live" ? current : "live"));
      }
    });
    source.onerror = () => {
      if (active) {
        setConnectionState("reconnecting");
      }
    };

    return () => {
      active = false;
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, []);

  const headerSummary = selectedProject
    ? buildProjectHeaderSummary(selectedProject, selectedProjectSummary)
    : `Watching ${effectiveSnapshot.running_count} active agents across ${Math.max(projects.length, effectiveSnapshot.project_count)} projects.`;

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-lockup">
            <div className="brand-mark">O</div>
            <div className="brand-copy">
              <div className="eyebrow">Operations</div>
              <div className="brand-title">OrchestrAI</div>
            </div>
          </div>
          <button
            type="button"
            className="button secondary icon-only"
            aria-label="Create project"
            title="Create project"
            onClick={() => {
              setCreateProjectFormState(emptyProjectForm());
              setNotice(idleNotice("Create a project, then fine-tune overrides only if you need them."));
              setSettingsMode("create");
            }}
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="sidebar-section">
          <button
            type="button"
            className={joinClassName("project-row", selectedProjectId === null ? "selected" : null)}
            onClick={() => {
              setSelectedProjectId(null);
            }}
          >
            <span className="project-avatar all">
              <Activity size={15} />
            </span>
            <span className="project-copy">
              <span className="project-name">All projects</span>
              <span className="project-meta">
                {effectiveSnapshot.running_count} active · {Math.max(projects.length, effectiveSnapshot.project_count)} loaded
              </span>
            </span>
            <ChevronRight size={14} className="project-chevron" />
          </button>

          <div className="project-list">
            {projects.map((project) => (
              <ProjectListItem
                key={project.id}
                project={project}
                summary={summaries.get(project.workflowPath) ?? null}
                selected={project.id === selectedProjectId}
                onSelect={() => {
                  setSelectedProjectId(project.id);
                }}
              />
            ))}
          </div>
        </div>

        <footer className="sidebar-footer">
          <button
            type="button"
            className="button ghost sidebar-action"
            onClick={() => {
              setNotice(idleNotice("Shared keys and default runtime values live here."));
              setSettingsMode("global");
            }}
          >
            <Cog size={15} />
            <span>Global settings</span>
          </button>
          <div className="sidebar-meta">
            <div className={joinClassName("connection-line", connectionState)}>
              <span className="connection-dot" />
              <span>{connectionLabel(connectionState)}</span>
            </div>
            <span className="sidebar-meta-text">Updated {formatSnapshotAge(effectiveSnapshot)}</span>
          </div>
          <ThemePicker
            value={themePreference}
            onChange={(nextPreference) => {
              writeThemePreference(nextPreference);
              setThemePreference(nextPreference);
            }}
          />
        </footer>
      </aside>

      <main className="page-shell">
        <header className="page-header">
          <div className="page-heading">
            <div className="eyebrow">{selectedProject ? "Project" : "Overview"}</div>
            <h1>{selectedProject ? projectLabel(selectedProject) : "Operations Overview"}</h1>
            <p>{headerSummary}</p>
            <div className="header-links">
              {selectedProject ? (
                <>
                  <MetaChip label={selectedProject.projectSlug} />
                  {selectedProject.githubRepository ? (
                    <MetaChip label={selectedProject.githubRepository} icon={<FolderGit2 size={12} />} />
                  ) : null}
                  {selectedProjectSummary?.linear_project.url ? (
                    <a className="meta-chip interactive" href={selectedProjectSummary.linear_project.url} target="_blank" rel="noreferrer">
                      <span>Linear project</span>
                      <ArrowUpRight size={12} />
                    </a>
                  ) : null}
                </>
              ) : (
                <>
                  <MetaChip label={`${effectiveSnapshot.project_count} projects`} />
                  <MetaChip label={`${effectiveSnapshot.running_count} active agents`} icon={<Activity size={12} />} />
                </>
              )}
            </div>
          </div>

          <div className="header-actions">
            {selectedProject ? (
              <>
                <button
                  type="button"
                  className={selectedProject.runtimeRunning ? "button secondary" : "button primary"}
                  onClick={() => {
                    void toggleProjectRuntime(
                      selectedProject,
                      selectedProject.runtimeRunning ? "stop" : "start",
                      setNotice,
                      setProjects,
                      setSelectedProjectId,
                      setProjectFormState
                    );
                  }}
                >
                  {selectedProject.runtimeRunning ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
                  <span>{selectedProject.runtimeRunning ? "Stop project" : "Start project"}</span>
                </button>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    setNotice(idleNotice("Project settings only store local overrides."));
                    setSettingsMode("project");
                  }}
                >
                  <Settings2 size={16} />
                  <span>Project settings</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setNotice(idleNotice("Shared keys and default runtime values live here."));
                  setSettingsMode("global");
                }}
              >
                <Cog size={16} />
                <span>Global settings</span>
              </button>
            )}
          </div>
        </header>

        <section className="stat-grid">
          <StatCard
            label="Active agents"
            value={String(activeAgents.length)}
            note={selectedProject ? "Selected project" : "All running projects"}
            icon={<Activity size={16} />}
          />
          <StatCard
            label="Retry queue"
            value={String(selectedSnapshot.retry_count)}
            note="Waiting for next attempt"
            icon={<RefreshCw size={16} />}
          />
          <StatCard
            label="Completed"
            value={String(selectedSnapshot.completed_count)}
            note="Current runtime session"
            icon={<CheckCircle2 size={16} />}
          />
          <StatCard
            label="Tokens"
            value={formatInteger(selectedSnapshot.codex_totals.totalTokens)}
            note="Total consumed in focus scope"
            icon={<Minus size={16} />}
          />
        </section>

        <section className="layout-grid">
          <Surface
            className="span-two"
            title="Active agents"
            subtitle="Current ticket, runtime, and the latest meaningful progress signal."
          >
            <AgentTable entries={activeAgents} nowMs={nowMs} />
          </Surface>

          <Surface title="What changed" subtitle="The newest orchestration events, without the raw internals.">
            <EventTimeline events={selectedSnapshot.recent_events} />
          </Surface>

          <Surface title="Retry queue" subtitle="Tickets that will be picked up again automatically.">
            <RetryTable entries={queuedRetries} nowMs={nowMs} />
          </Surface>

          <Surface title={selectedProject ? "Project details" : "Fleet details"} subtitle="Configuration posture and runtime health.">
            <ProjectOverview
              selectedProject={selectedProject}
              selectedProjectSummary={selectedProjectSummary}
              snapshot={selectedSnapshot}
              globalConfig={globalConfig}
              projectCount={projects.length}
            />
          </Surface>
        </section>
      </main>

      <SettingsDialog
        mode={settingsMode}
        onClose={() => {
          setSettingsMode(null);
        }}
        globalConfig={globalConfig}
        globalFormState={globalFormState}
        setGlobalFormState={setGlobalFormState}
        selectedProject={selectedProject}
        projectFormState={projectFormState}
        setProjectFormState={setProjectFormState}
        createProjectFormState={createProjectFormState}
        setCreateProjectFormState={setCreateProjectFormState}
        notice={notice}
        setNotice={setNotice}
        setProjects={setProjects}
        setSelectedProjectId={setSelectedProjectId}
        setSetupContext={setSetupContext}
        onComplete={() => {
          setSettingsMode(null);
        }}
      />
    </div>
  );
}

function ProjectListItem(props: {
  project: ManagedProjectRecord;
  summary: StatusSnapshot["projects"][number] | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { project, summary, selected, onSelect } = props;
  const meta = project.runtimeRunning
    ? `${summary?.running_count ?? 0} active · ${summary?.retry_count ?? 0} queued`
    : "Stopped";

  return (
    <button type="button" className={joinClassName("project-row", selected ? "selected" : null)} onClick={onSelect}>
      <span className={joinClassName("project-avatar", project.runtimeRunning ? "running" : "stopped")}>{projectInitial(project)}</span>
      <span className="project-copy">
        <span className="project-name">{projectLabel(project)}</span>
        <span className="project-meta">{meta}</span>
      </span>
      <span className={joinClassName("status-pill", project.runtimeRunning ? "running" : "stopped")}>
        {project.runtimeRunning ? "Live" : "Off"}
      </span>
    </button>
  );
}

function SettingsDialog(props: {
  mode: SettingsMode;
  onClose: () => void;
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
  onComplete: () => void;
}) {
  const {
    mode,
    onClose,
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
    setSetupContext,
    onComplete
  } = props;

  const open = mode !== null;

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => (!nextOpen ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-panel">
          <div className="dialog-header">
            <div>
              <Dialog.Title className="dialog-title">{settingsTitle(mode, selectedProject)}</Dialog.Title>
              <Dialog.Description className="dialog-description">
                {settingsDescription(mode, selectedProject)}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="button ghost icon-only" aria-label="Close settings">
                <Minus size={16} />
              </button>
            </Dialog.Close>
          </div>

          {mode === "global" ? (
            <GlobalSettingsForm
              globalConfig={globalConfig}
              formState={globalFormState}
              setFormState={setGlobalFormState}
              notice={notice}
              setNotice={setNotice}
              setProjects={setProjects}
              setSelectedProjectId={setSelectedProjectId}
              setSetupContext={setSetupContext}
              onComplete={onComplete}
            />
          ) : null}

          {mode === "project" && selectedProject ? (
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
              onComplete={onComplete}
            />
          ) : null}

          {mode === "create" ? (
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
              onComplete={onComplete}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GlobalSettingsForm(props: {
  globalConfig: GlobalConfigRecord;
  formState: GlobalFormState;
  setFormState: Dispatch<SetStateAction<GlobalFormState>>;
  notice: StatusNotice;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>;
  onComplete: () => void;
}) {
  const { globalConfig, formState, setFormState, notice, setNotice, setProjects, setSelectedProjectId, setSetupContext, onComplete } =
    props;

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void saveGlobalSettings({
          formState,
          setNotice,
          setSetupContext,
          setGlobalFormState: setFormState,
          setProjects,
          setSelectedProjectId
        }).then((saved) => {
          if (saved) {
            onComplete();
          }
        });
      }}
    >
      <div className="field-grid two-up">
        <Field label="Default polling interval">
          <input
            className="input"
            value={formState.pollingIntervalMs}
            onChange={(event) => {
              setFormState((current) => ({ ...current, pollingIntervalMs: event.target.value }));
            }}
          />
        </Field>
        <Field label="Default concurrent agents">
          <input
            className="input"
            value={formState.maxConcurrentAgents}
            onChange={(event) => {
              setFormState((current) => ({ ...current, maxConcurrentAgents: event.target.value }));
            }}
          />
        </Field>
        <Field label={`Shared Linear API key${globalConfig.hasLinearApiKey ? " (leave blank to keep)" : ""}`} className="full">
          <input
            className="input"
            type="password"
            value={formState.linearApiKey}
            placeholder={globalConfig.hasLinearApiKey ? "Keep existing key" : "lin_api_..."}
            onChange={(event) => {
              setFormState((current) => ({
                ...current,
                linearApiKey: event.target.value,
                clearLinearApiKey: false
              }));
            }}
          />
        </Field>
        <Field label={`Shared GitHub token${globalConfig.hasGithubToken ? " (leave blank to keep)" : ""}`} className="full">
          <input
            className="input"
            type="password"
            value={formState.githubToken}
            placeholder={globalConfig.hasGithubToken ? "Keep existing token" : "Optional"}
            onChange={(event) => {
              setFormState((current) => ({
                ...current,
                githubToken: event.target.value,
                clearGithubToken: false
              }));
            }}
          />
        </Field>
      </div>

      <div className="toggle-list">
        {globalConfig.hasLinearApiKey ? (
          <ToggleRow
            checked={formState.clearLinearApiKey}
            label="Clear shared Linear API key"
            onCheckedChange={(checked) => {
              setFormState((current) => ({
                ...current,
                clearLinearApiKey: checked,
                linearApiKey: checked ? "" : current.linearApiKey
              }));
            }}
          />
        ) : null}
        {globalConfig.hasGithubToken ? (
          <ToggleRow
            checked={formState.clearGithubToken}
            label="Clear shared GitHub token"
            onCheckedChange={(checked) => {
              setFormState((current) => ({
                ...current,
                clearGithubToken: checked,
                githubToken: checked ? "" : current.githubToken
              }));
            }}
          />
        ) : null}
      </div>

      <DialogFooter notice={notice}>
        <button className="button primary" type="submit" disabled={notice.kind === "saving"}>
          Save global settings
        </button>
      </DialogFooter>
    </form>
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
  onComplete: () => void;
}) {
  const { mode, formState, setFormState, selectedProject, globalConfig, notice, setNotice, setProjects, setSelectedProjectId, onComplete } =
    props;

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void saveProject({
          mode,
          selectedProject,
          formState,
          setNotice,
          setProjects,
          setSelectedProjectId
        }).then((saved) => {
          if (saved) {
            onComplete();
          }
        });
      }}
    >
      <div className="field-grid two-up">
        <Field label="Project name">
          <input
            className="input"
            value={formState.displayName}
            placeholder="Optional display name"
            onChange={(event) => {
              setFormState((current) => ({ ...current, displayName: event.target.value }));
            }}
          />
        </Field>
        <Field label="Linear project slug">
          <input
            className="input"
            value={formState.projectSlug}
            placeholder="project-abc123"
            onChange={(event) => {
              setFormState((current) => ({ ...current, projectSlug: event.target.value }));
            }}
          />
        </Field>
        <Field label="GitHub repository" className="full">
          <input
            className="input"
            value={formState.githubRepository}
            placeholder="owner/repo"
            onChange={(event) => {
              setFormState((current) => ({ ...current, githubRepository: event.target.value }));
            }}
          />
        </Field>
        <Field label="Linear API key" className="full">
          <input
            className="input"
            type="password"
            value={formState.linearApiKey}
            disabled={formState.useGlobalLinearApiKey}
            placeholder={formState.useGlobalLinearApiKey ? "Using shared key" : "Optional project override"}
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
        <Field label="GitHub token" className="full">
          <input
            className="input"
            type="password"
            value={formState.githubToken}
            disabled={formState.useGlobalGithubToken}
            placeholder={formState.useGlobalGithubToken ? "Using shared token" : "Optional project override"}
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
        <Field label="Polling interval">
          <input
            className="input"
            value={formState.pollingIntervalMs}
            disabled={formState.useGlobalPollingIntervalMs}
            placeholder={String(globalConfig.defaults.pollingIntervalMs)}
            onChange={(event) => {
              setFormState((current) => ({ ...current, pollingIntervalMs: event.target.value }));
            }}
          />
        </Field>
        <Field label="Concurrent agents">
          <input
            className="input"
            value={formState.maxConcurrentAgents}
            disabled={formState.useGlobalMaxConcurrentAgents}
            placeholder={String(globalConfig.defaults.maxConcurrentAgents)}
            onChange={(event) => {
              setFormState((current) => ({ ...current, maxConcurrentAgents: event.target.value }));
            }}
          />
        </Field>
      </div>

      <div className="toggle-list">
        <ToggleRow
          checked={formState.useGlobalPollingIntervalMs}
          label="Use shared polling interval"
          onCheckedChange={(checked) => {
            setFormState((current) => ({ ...current, useGlobalPollingIntervalMs: checked }));
          }}
        />
        <ToggleRow
          checked={formState.useGlobalMaxConcurrentAgents}
          label="Use shared concurrent-agent limit"
          onCheckedChange={(checked) => {
            setFormState((current) => ({ ...current, useGlobalMaxConcurrentAgents: checked }));
          }}
        />
      </div>

      <DialogFooter notice={notice}>
        {mode === "update" && selectedProject ? (
          <button
            type="button"
            className="button danger"
            onClick={() => {
              void removeProject(selectedProject, setNotice, setProjects, setSelectedProjectId).then((removed) => {
                if (removed) {
                  onComplete();
                }
              });
            }}
          >
            <Trash2 size={15} />
            <span>Remove project</span>
          </button>
        ) : null}
        <button className="button primary" type="submit" disabled={notice.kind === "saving"}>
          {mode === "create" ? "Create project" : "Save project"}
        </button>
      </DialogFooter>
    </form>
  );
}

function StatCard(props: { label: string; value: string; note: string; icon: ReactNode }) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span className="stat-label">{props.label}</span>
        <span className="stat-icon">{props.icon}</span>
      </div>
      <div className="stat-value">{props.value}</div>
      <div className="stat-note">{props.note}</div>
    </article>
  );
}

function Surface(props: { title: string; subtitle: string; className?: string; children: ReactNode }) {
  return (
    <section className={joinClassName("surface", props.className ?? null)}>
      <div className="surface-header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
      </div>
      <div className="surface-body">{props.children}</div>
    </section>
  );
}

function AgentTable(props: { entries: StatusRunningEntry[]; nowMs: number }) {
  if (props.entries.length === 0) {
    return <EmptyState title="No active agents" body="When a ticket is picked up, it will appear here with its runtime and latest progress signal." />;
  }

  return (
    <div className="table-shell">
      <table className="data-table agents-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Phase</th>
            <th>Running</th>
            <th>Tokens</th>
            <th>What it’s doing</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => {
            const secondary = entry.recent_activity[1]?.message ?? `${entry.turn_count} turns completed`;
            return (
              <tr key={entry.issue_id}>
                <td>
                  <div className="row-title">{entry.identifier}</div>
                  <div className="row-subtitle">{entry.title}</div>
                </td>
                <td>
                  <span className="phase-badge">{humanizePhase(entry.phase)}</span>
                  <div className="row-subtitle">{entry.state}</div>
                </td>
                <td className="mono">{formatElapsedShort(props.nowMs - entry.started_at_ms)}</td>
                <td className="mono">{formatInteger(entry.codex_total_tokens)}</td>
                <td>
                  <div className="activity-primary">{entry.activity}</div>
                  <div className="activity-secondary">{secondary}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventTimeline(props: { events: StatusSnapshot["recent_events"] }) {
  if (props.events.length === 0) {
    return <EmptyState title="No recent events" body="This feed fills in as the runtime dispatches work, retries tickets, and advances agent phases." />;
  }

  return (
    <div className="timeline">
      {props.events.slice(0, 12).map((event, index) => (
        <div className="timeline-item" key={`${event.timestamp}:${event.message}:${index}`}>
          <div className="timeline-meta">
            <span className="timeline-time">{formatRelativeTime(event.timestamp)}</span>
            <span className={joinClassName("event-level", event.level)}>{event.level}</span>
          </div>
          <div className="timeline-copy">
            <div className="row-title">{event.issueIdentifier ?? "runtime"}</div>
            <div className="row-subtitle">{describeOperatorEvent(event)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RetryTable(props: { entries: StatusRetryEntry[]; nowMs: number }) {
  if (props.entries.length === 0) {
    return <EmptyState title="Queue is clear" body="Nothing is waiting in backoff right now." />;
  }

  return (
    <div className="table-shell">
      <table className="data-table retry-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Due</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.slice(0, 8).map((entry) => (
            <tr key={entry.issue_id}>
              <td>
                <div className="row-title">{entry.identifier}</div>
                <div className="row-subtitle">{entry.title}</div>
              </td>
              <td className="mono">{formatElapsedShort(Math.max(0, entry.due_at_ms - props.nowMs))}</td>
              <td className="row-subtitle">{entry.error ?? "Continuation run"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectOverview(props: {
  selectedProject: ManagedProjectRecord | null;
  selectedProjectSummary: StatusSnapshot["projects"][number] | null;
  snapshot: StatusSnapshot;
  globalConfig: GlobalConfigRecord;
  projectCount: number;
}) {
  const { selectedProject, selectedProjectSummary, snapshot, globalConfig, projectCount } = props;

  if (!selectedProject) {
    return (
      <div className="detail-grid">
        <DetailItem label="Projects loaded" value={String(projectCount)} />
        <DetailItem label="Active agents" value={String(snapshot.running_count)} />
        <DetailItem label="Shared polling" value={`${globalConfig.defaults.pollingIntervalMs} ms`} />
        <DetailItem label="Shared concurrency" value={String(globalConfig.defaults.maxConcurrentAgents)} />
      </div>
    );
  }

  return (
    <div className="detail-grid">
      <DetailItem label="Runtime" value={selectedProject.runtimeRunning ? "Running" : "Stopped"} tone={selectedProject.runtimeRunning ? "good" : "muted"} />
      <DetailItem label="Linear slug" value={selectedProject.projectSlug} />
      <DetailItem
        label="Repository"
        value={selectedProject.githubRepository ?? "Not set"}
        suffix={
          selectedProjectSummary?.linear_project.url ? (
            <a href={selectedProjectSummary.linear_project.url} target="_blank" rel="noreferrer" className="detail-link">
              Open Linear
            </a>
          ) : null
        }
      />
      <DetailItem
        label="Linear key"
        value={selectedProject.usesGlobalLinearApiKey ? "Inherited" : selectedProject.hasLinearApiKey ? "Project override" : "Missing"}
      />
      <DetailItem
        label="GitHub token"
        value={selectedProject.usesGlobalGithubToken ? "Inherited" : selectedProject.hasGithubToken ? "Project override" : "Optional"}
      />
      <DetailItem
        label="Polling"
        value={`${selectedProject.pollingIntervalMs} ms`}
        note={selectedProject.usesGlobalPollingIntervalMs ? "Shared default" : "Project override"}
      />
      <DetailItem
        label="Concurrent agents"
        value={String(selectedProject.maxConcurrentAgents)}
        note={selectedProject.usesGlobalMaxConcurrentAgents ? "Shared default" : "Project override"}
      />
      <DetailItem
        label="Rate limits"
        value={renderRateLimitSummary(selectedProjectSummary)}
      />
    </div>
  );
}

function DetailItem(props: { label: string; value: string; note?: string; tone?: "good" | "muted"; suffix?: ReactNode }) {
  return (
    <div className="detail-item">
      <div className="detail-label">{props.label}</div>
      <div className={joinClassName("detail-value", props.tone === "good" ? "good" : null)}>{props.value}</div>
      {props.note ? <div className="detail-note">{props.note}</div> : null}
      {props.suffix ? <div className="detail-suffix">{props.suffix}</div> : null}
    </div>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="row-title">{props.title}</div>
      <div className="row-subtitle">{props.body}</div>
    </div>
  );
}

function Field(props: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={joinClassName("field", props.className ?? null)}>
      <span className="field-label">{props.label}</span>
      {props.children}
    </label>
  );
}

function ToggleRow(props: { checked: boolean; label: string; onCheckedChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{props.label}</span>
      <input
        className="toggle-input"
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onCheckedChange(event.target.checked);
        }}
      />
    </label>
  );
}

function DialogFooter(props: { notice: StatusNotice; children: ReactNode }) {
  return (
    <div className="dialog-footer">
      <div className={joinClassName("notice", props.notice.kind)}>{props.notice.message}</div>
      <div className="dialog-actions">{props.children}</div>
    </div>
  );
}

function MetaChip(props: { label: string; icon?: ReactNode }) {
  return (
    <span className="meta-chip">
      {props.icon}
      <span>{props.label}</span>
    </span>
  );
}

function ThemePicker(props: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  return (
    <label className="theme-picker">
      <span className="theme-label">
        {props.value === "dark" ? <MoonStar size={14} /> : <SunMedium size={14} />}
        <span>Theme</span>
      </span>
      <select
        className="select"
        value={props.value}
        aria-label="Theme preference"
        onChange={(event) => {
          props.onChange(event.target.value as ThemePreference);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function settingsTitle(mode: SettingsMode, selectedProject: ManagedProjectRecord | null): string {
  switch (mode) {
    case "global":
      return "Global settings";
    case "project":
      return selectedProject ? `Edit ${projectLabel(selectedProject)}` : "Project settings";
    case "create":
      return "Create project";
    default:
      return "Settings";
  }
}

function settingsDescription(mode: SettingsMode, selectedProject: ManagedProjectRecord | null): string {
  switch (mode) {
    case "global":
      return "Shared API keys and default runtime values.";
    case "project":
      return selectedProject
        ? "Only local overrides live here. Anything turned off inherits the shared global default."
        : "Select a project first.";
    case "create":
      return "Start with the slug and repository, then override only what this project truly needs.";
    default:
      return "";
  }
}

function buildProjectHeaderSummary(
  project: ManagedProjectRecord,
  summary: StatusSnapshot["projects"][number] | null
): string {
  if (!project.runtimeRunning) {
    return "This project is configured but currently stopped.";
  }

  return `${summary?.running_count ?? 0} active agents · ${summary?.retry_count ?? 0} queued retries · ${formatInteger(summary?.codex_totals.totalTokens ?? 0)} total tokens`;
}

function renderRateLimitSummary(summary: StatusSnapshot["projects"][number] | null): string {
  const limits = summary?.linear_rate_limits;
  if (!limits) {
    return "Unavailable";
  }

  const requests = limits.requests;
  if (!requests) {
    return "Observed, no request window";
  }

  return `${requests.remaining ?? "n/a"}/${requests.limit ?? "n/a"} remaining`;
}

function humanizePhase(phase: string): string {
  switch (phase) {
    case "preparing_workspace":
      return "Preparing workspace";
    case "running_before_run_hook":
      return "Preflight";
    case "launching_agent_process":
      return "Launching agent";
    case "initializing_session":
      return "Initializing";
    case "building_prompt":
      return "Planning";
    case "streaming_turn":
      return "Working";
    case "refreshing_issue_state":
      return "Syncing state";
    case "finishing":
      return "Finishing";
    default:
      return phase;
  }
}

function describeOperatorEvent(event: StatusSnapshot["recent_events"][number]): string {
  if (event.message === "worker activity" && typeof event.fields?.activity === "string") {
    return event.fields.activity;
  }

  if (event.message === "issue dispatched") {
    return `Picked up from ${String(event.fields?.state ?? "active")}`;
  }

  if (event.message === "retry scheduled") {
    return `Retry scheduled in ${formatElapsedShort(Number(event.fields?.delay_ms ?? 0))}`;
  }

  if (event.message.startsWith("codex ")) {
    return event.message.replace(/^codex /, "").replaceAll("_", " ");
  }

  return event.message;
}

async function refreshSetupContext(
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>,
  setGlobalFormState: Dispatch<SetStateAction<GlobalFormState>>
): Promise<void> {
  const nextContext = await fetchJson<DashboardSetupContext>("/api/setup/context");
  setSetupContext(nextContext);
  setGlobalFormState(globalConfigToForm(nextContext.globalConfig));
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

    return current === null ? null : nextProjects[0]?.id ?? null;
  });
}

async function saveGlobalSettings(props: {
  formState: GlobalFormState;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setSetupContext: Dispatch<SetStateAction<DashboardSetupContext | null>>;
  setGlobalFormState: Dispatch<SetStateAction<GlobalFormState>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
}): Promise<boolean> {
  const { formState, setNotice, setSetupContext, setGlobalFormState, setProjects, setSelectedProjectId } = props;
  setNotice({ kind: "saving", message: "Saving global settings..." });

  try {
    const body = {
      pollingIntervalMs: parseOptionalInteger(formState.pollingIntervalMs),
      maxConcurrentAgents: parseOptionalInteger(formState.maxConcurrentAgents),
      linearApiKey: normalizeOptionalText(formState.linearApiKey),
      githubToken: normalizeOptionalText(formState.githubToken),
      clearLinearApiKey: formState.clearLinearApiKey,
      clearGithubToken: formState.clearGithubToken
    };
    await fetchJson<GlobalConfigRecord>("/api/settings/global", {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    await refreshSetupContext(setSetupContext, setGlobalFormState);
    await refreshProjects(setProjects, setSelectedProjectId);
    setNotice({ kind: "success", message: "Global settings updated." });
    return true;
  } catch (error) {
    setNotice({ kind: "error", message: errorMessage(error) });
    return false;
  }
}

async function saveProject(props: {
  mode: "create" | "update";
  selectedProject: ManagedProjectRecord | null;
  formState: ProjectFormState;
  setNotice: Dispatch<SetStateAction<StatusNotice>>;
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
}): Promise<boolean> {
  const { mode, selectedProject, formState, setNotice, setProjects, setSelectedProjectId } = props;
  setNotice({ kind: "saving", message: mode === "create" ? "Creating project..." : "Saving project..." });

  try {
    const input = projectFormToApiInput(formState);
    const result = mode === "create"
      ? await fetchJson<ProjectSetupResult>("/api/projects", {
          method: "POST",
          body: JSON.stringify(input satisfies ProjectSetupInput)
        })
      : await fetchJson<ManagedProjectRecord>("/api/projects", {
          method: "PATCH",
          body: JSON.stringify({
            id: selectedProject!.id,
            ...input
          } satisfies ProjectUpdateInput)
        });

    await refreshProjects(setProjects, setSelectedProjectId);
    setSelectedProjectId(result.id);
    setNotice({ kind: "success", message: mode === "create" ? "Project created." : "Project saved." });
    return true;
  } catch (error) {
    setNotice({ kind: "error", message: errorMessage(error) });
    return false;
  }
}

async function toggleProjectRuntime(
  project: ManagedProjectRecord,
  intent: "start" | "stop",
  setNotice: Dispatch<SetStateAction<StatusNotice>>,
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>,
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>,
  setProjectFormState: Dispatch<SetStateAction<ProjectFormState>>
): Promise<void> {
  setNotice({ kind: "saving", message: intent === "start" ? `Starting ${projectLabel(project)}...` : `Stopping ${projectLabel(project)}...` });

  try {
    const endpoint = intent === "start" ? "/api/projects/start" : "/api/projects/stop";
    const updated = await fetchJson<ManagedProjectRecord>(endpoint, {
      method: "POST",
      body: JSON.stringify({ id: project.id })
    });
    setProjects((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    setSelectedProjectId(updated.id);
    setProjectFormState(projectToForm(updated));
    setNotice({ kind: "success", message: intent === "start" ? "Project started." : "Project stopped." });
  } catch (error) {
    setNotice({ kind: "error", message: errorMessage(error) });
  }
}

async function removeProject(
  project: ManagedProjectRecord,
  setNotice: Dispatch<SetStateAction<StatusNotice>>,
  setProjects: Dispatch<SetStateAction<ManagedProjectRecord[]>>,
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>
): Promise<boolean> {
  if (!window.confirm(`Remove ${projectLabel(project)}?`)) {
    return false;
  }

  setNotice({ kind: "saving", message: `Removing ${projectLabel(project)}...` });

  try {
    await fetchVoid("/api/projects", {
      method: "DELETE",
      body: JSON.stringify({ id: project.id })
    });
    await refreshProjects(setProjects, setSelectedProjectId);
    setSelectedProjectId(null);
    setNotice({ kind: "success", message: "Project removed." });
    return true;
  } catch (error) {
    setNotice({ kind: "error", message: errorMessage(error) });
    return false;
  }
}

function projectFormToApiInput(formState: ProjectFormState): ProjectSetupInput {
  return {
    displayName: normalizeOptionalText(formState.displayName),
    projectSlug: formState.projectSlug.trim(),
    githubRepository: formState.githubRepository.trim(),
    linearApiKey: normalizeOptionalText(formState.linearApiKey),
    githubToken: normalizeOptionalText(formState.githubToken),
    pollingIntervalMs: parseOptionalInteger(formState.pollingIntervalMs),
    maxConcurrentAgents: parseOptionalInteger(formState.maxConcurrentAgents),
    useGlobalLinearApiKey: formState.useGlobalLinearApiKey,
    useGlobalGithubToken: formState.useGlobalGithubToken,
    useGlobalPollingIntervalMs: formState.useGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents: formState.useGlobalMaxConcurrentAgents
  };
}

function projectLabel(project: ManagedProjectRecord): string {
  return normalizeOptionalText(project.displayName) ?? project.projectSlug;
}

function projectInitial(project: ManagedProjectRecord): string {
  const label = projectLabel(project).trim();
  return label.slice(0, 1).toUpperCase();
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
    pollingIntervalMs: String(project.pollingIntervalMs),
    maxConcurrentAgents: String(project.maxConcurrentAgents),
    useGlobalPollingIntervalMs: project.usesGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents: project.usesGlobalMaxConcurrentAgents
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

function filterSnapshotByProject(snapshot: StatusSnapshot, projectId: string | null): StatusSnapshot {
  if (!projectId) {
    return snapshot;
  }

  const projectMatch = snapshot.projects.filter((project) => project.workflow_path === projectId);
  return {
    ...snapshot,
    project_count: projectMatch.length,
    running: snapshot.running.filter((entry) => entry.workflow_path === projectId),
    retries: snapshot.retries.filter((entry) => entry.workflow_path === projectId),
    projects: projectMatch,
    running_count: snapshot.running.filter((entry) => entry.workflow_path === projectId).length,
    retry_count: snapshot.retries.filter((entry) => entry.workflow_path === projectId).length,
    completed_count: projectMatch.reduce((sum, project) => sum + project.completed_count, 0),
    claimed_count: projectMatch.reduce((sum, project) => sum + project.claimed_count, 0),
    codex_totals: projectMatch.reduce(
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
    ),
    recent_events: snapshot.recent_events.filter((event) => event.fields?.workflow_path === projectId || !event.fields?.workflow_path)
  };
}

function sortRunningEntries(entries: StatusRunningEntry[]): StatusRunningEntry[] {
  return [...entries].sort((left, right) => left.started_at_ms - right.started_at_ms || left.identifier.localeCompare(right.identifier));
}

function sortRetryEntries(entries: StatusRetryEntry[]): StatusRetryEntry[] {
  return [...entries].sort((left, right) => left.due_at_ms - right.due_at_ms || left.identifier.localeCompare(right.identifier));
}

function connectionLabel(connectionState: ConnectionState): string {
  switch (connectionState) {
    case "live":
      return "Live";
    case "reconnecting":
      return "Syncing";
    case "failed":
      return "Offline";
    case "connecting":
    default:
      return "Connecting";
  }
}

function formatSnapshotAge(snapshot: StatusSnapshot): string {
  if (!snapshot.updated_at) {
    return "just now";
  }

  return formatRelativeTime(snapshot.updated_at);
}

function formatRelativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "just now";
  }

  if (elapsed < 60_000) {
    return `${Math.max(1, Math.floor(elapsed / 1000))}s ago`;
  }

  return `${formatElapsedShort(elapsed)} ago`;
}

function parseOptionalInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const errorText =
      body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${response.status})`;
    throw new Error(errorText);
  }

  return body as T;
}

async function fetchVoid(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (response.ok) {
    return;
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  const message =
    body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `Request failed (${response.status})`;
  throw new Error(message);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem(themeStorageKey);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
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

function idleNotice(message = "Settings live behind the cog. Runtime data stays here in the main view."): StatusNotice {
  return { kind: "idle", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function joinClassName(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Dashboard root element not found");
}

createRoot(rootElement).render(<DashboardApp />);
