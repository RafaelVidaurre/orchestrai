export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface ProjectConfig {
  displayName: string | null;
  enabled: boolean;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxTurns: number;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export type AgentProvider = "codex" | "claude" | "grok";

export interface RuntimeConfig {
  provider: AgentProvider;
  model: string;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
}

export interface ClaudeConfig {
  command: string;
  permissionMode: string;
  maxBudgetUsd: number | null;
}

export interface GrokConfig {
  apiKey: string;
  baseUrl: string;
  maxToolRounds: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
}

export interface ServiceConfig {
  workflowPath: string;
  project: ProjectConfig;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  runtime: RuntimeConfig;
  codex: CodexConfig;
  claude: ClaudeConfig;
  grok: GrokConfig;
  server: ServerConfig;
}

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
  version: number;
  env: NodeJS.ProcessEnv;
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
  runPath: string;
}

export type WorkerCancelReason =
  | "stalled"
  | "canceled_non_active"
  | "canceled_terminal"
  | "service_stopping";

export interface AgentUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface AgentRuntimeEvent {
  provider: AgentProvider;
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "user_input_auto_answered"
    | "approval_auto_approved"
    | "tool_call_completed"
    | "tool_call_failed"
    | "unsupported_tool_call"
    | "notification"
    | "other_message"
    | "malformed";
  timestamp: string;
  agentProcessPid: number | null;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  usage?: AgentUsageSnapshot;
  rateLimits?: unknown;
  message?: string;
}

export interface WorkerActivityEvent {
  phase:
    | "preparing_workspace"
    | "running_before_run_hook"
    | "launching_agent_process"
    | "initializing_session"
    | "building_prompt"
    | "streaming_turn"
    | "refreshing_issue_state"
    | "finishing";
  timestamp: string;
  message: string;
}

export interface AgentActivityEntry {
  timestamp: string;
  source: "worker" | "agent" | "system";
  phase: string | null;
  message: string;
}

export interface AgentTranscriptEntry {
  timestamp: string;
  source: "worker" | "agent" | "system";
  phase: string | null;
  kind: "status" | "message" | "reasoning" | "command" | "tool" | "approval" | "system";
  message: string;
}

export interface WorkerSuccessOutcome {
  kind: "normal";
  issue: Issue;
  turnCount: number;
}

export interface WorkerFailureOutcome {
  kind: "failed" | "timed_out" | "stalled" | "canceled_non_active" | "canceled_terminal" | "service_stopping";
  error: string;
  errorCode: string | null;
  errorDetails: Record<string, unknown> | null;
  issue: Issue;
  turnCount: number;
}

export type WorkerOutcome = WorkerSuccessOutcome | WorkerFailureOutcome;

export interface RetryEntry {
  issueId: string;
  identifier: string;
  title: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string | null;
}

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  agentProvider: AgentProvider;
  retryAttempt: number | null;
  startedAtMs: number;
  worker: {
    cancel: (reason: WorkerCancelReason) => void;
    result: Promise<WorkerOutcome>;
  };
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  agentProcessPid: number | null;
  lastAgentEvent: string | null;
  lastAgentTimestampMs: number | null;
  lastAgentMessage: string | null;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
  cancellingReason: WorkerCancelReason | null;
  phase: WorkerActivityEvent["phase"] | "queued";
  activity: string;
  recentActivity: AgentActivityEntry[];
  transcriptActivity: AgentTranscriptEntry[];
}

export interface RuntimeTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface LinearProjectInfo {
  slug: string;
  name: string | null;
  url: string | null;
  updated_at: string | null;
}

export interface LinearRateLimitWindow {
  limit: number | null;
  remaining: number | null;
  reset_at_ms: number | null;
}

export interface LinearRateLimits {
  auth_mode: "api_key" | "unknown";
  observed_at: string;
  requests: LinearRateLimitWindow | null;
  complexity: LinearRateLimitWindow | null;
  endpoint_requests:
    | (LinearRateLimitWindow & {
        name: string | null;
      })
    | null;
  last_query_complexity: number | null;
}

export interface OperatorEvent {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  issueId?: string;
  issueIdentifier?: string;
  fields?: Record<string, unknown>;
}

export interface FatalProjectError {
  timestamp: string;
  workflow_path: string;
  provider: AgentProvider | null;
  stage: "startup" | "dispatch" | "worker" | "retry" | "reconcile";
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  issue_id: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  log_path: string;
}

export interface StatusProjectSummary {
  workflow_path: string;
  display_name: string | null;
  poll_interval_ms: number;
  max_concurrent_agents: number;
  agent_provider: AgentProvider;
  running_count: number;
  retry_count: number;
  completed_count: number;
  claimed_count: number;
  linear_project: LinearProjectInfo;
  linear_rate_limits: LinearRateLimits | null;
  agent_totals: RuntimeTotals;
  agent_rate_limits: unknown;
  updated_at: string;
}

export interface StatusProjectState {
  workflow_path: string;
  enabled: boolean;
  runtime_running: boolean;
  fatal_error: FatalProjectError | null;
  updated_at: string;
}

export interface StatusRunningEntry {
  workflow_path: string;
  project_slug: string;
  project_name: string | null;
  project_url: string | null;
  issue_id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  attempt: number | null;
  agent_provider: AgentProvider;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  agent_process_pid: number | null;
  phase: string;
  activity: string;
  last_event: string | null;
  last_message: string | null;
  last_timestamp_ms: number | null;
  started_at_ms: number;
  turn_count: number;
  agent_input_tokens: number;
  agent_output_tokens: number;
  agent_total_tokens: number;
  issue_url: string | null;
  recent_activity: AgentActivityEntry[];
  transcript_activity: AgentTranscriptEntry[];
}

export interface StatusRetryEntry {
  workflow_path: string;
  project_slug: string;
  project_name: string | null;
  project_url: string | null;
  issue_id: string;
  identifier: string;
  title: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

export interface StatusSnapshot {
  updated_at: string;
  project_count: number;
  running_count: number;
  retry_count: number;
  completed_count: number;
  claimed_count: number;
  projects: StatusProjectSummary[];
  project_states: StatusProjectState[];
  running: StatusRunningEntry[];
  retries: StatusRetryEntry[];
  agent_totals: RuntimeTotals;
  recent_events: OperatorEvent[];
}

export interface StatusSource {
  snapshot(): StatusSnapshot;
  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void;
}

export interface DashboardSetupContext {
  projectsRoot: string;
  trackerKind: "linear";
  repositoryProvider: "github";
  globalConfig: GlobalConfigRecord;
}

export interface DashboardBootstrap {
  initialSnapshot: StatusSnapshot;
  setupContext: DashboardSetupContext;
}

export interface GlobalDefaults {
  pollingIntervalMs: number;
  maxConcurrentAgents: number;
  agentProvider: AgentProvider;
  agentModel: string;
}

export interface GlobalConfigRecord {
  projectsRoot: string;
  envFilePath: string;
  defaults: GlobalDefaults;
  hasLinearApiKey: boolean;
  hasXaiApiKey: boolean;
  hasGithubToken: boolean;
}

export interface GlobalConfigInput {
  pollingIntervalMs?: number | null;
  maxConcurrentAgents?: number | null;
  linearApiKey?: string | null;
  xaiApiKey?: string | null;
  githubToken?: string | null;
  agentProvider?: AgentProvider | null;
  agentModel?: string | null;
  clearLinearApiKey?: boolean;
  clearXaiApiKey?: boolean;
  clearGithubToken?: boolean;
}

export interface ProjectSetupInput {
  displayName?: string | null;
  projectSlug: string;
  linearApiKey?: string | null;
  xaiApiKey?: string | null;
  githubRepository: string;
  githubToken?: string | null;
  agentProvider?: AgentProvider | null;
  agentModel?: string | null;
  useGlobalAgentProvider?: boolean;
  useGlobalAgentModel?: boolean;
  pollingIntervalMs?: number | null;
  maxConcurrentAgents?: number | null;
  useGlobalLinearApiKey?: boolean;
  useGlobalXaiApiKey?: boolean;
  useGlobalGithubToken?: boolean;
  useGlobalPollingIntervalMs?: boolean;
  useGlobalMaxConcurrentAgents?: boolean;
}

export interface ProjectSetupResult {
  id: string;
  displayName: string | null;
  enabled: boolean;
  runtimeRunning: boolean;
  fatalError: FatalProjectError | null;
  projectSlug: string;
  githubRepository: string | null;
  agentProvider: AgentProvider;
  agentModel: string;
  workflowDirectory: string;
  workflowPath: string;
  envFilePath: string;
  pollingIntervalMs: number;
  maxConcurrentAgents: number;
  hasLinearApiKey: boolean;
  hasXaiApiKey: boolean;
  hasGithubToken: boolean;
  usesGlobalAgentProvider: boolean;
  usesGlobalAgentModel: boolean;
  usesGlobalLinearApiKey: boolean;
  usesGlobalXaiApiKey: boolean;
  usesGlobalGithubToken: boolean;
  usesGlobalPollingIntervalMs: boolean;
  usesGlobalMaxConcurrentAgents: boolean;
}

export interface ProjectUpdateInput {
  id: string;
  displayName?: string | null;
  projectSlug: string;
  githubRepository: string;
  linearApiKey?: string | null;
  xaiApiKey?: string | null;
  githubToken?: string | null;
  agentProvider?: AgentProvider | null;
  agentModel?: string | null;
  useGlobalAgentProvider?: boolean;
  useGlobalAgentModel?: boolean;
  pollingIntervalMs?: number | null;
  maxConcurrentAgents?: number | null;
  useGlobalLinearApiKey?: boolean;
  useGlobalXaiApiKey?: boolean;
  useGlobalGithubToken?: boolean;
  useGlobalPollingIntervalMs?: boolean;
  useGlobalMaxConcurrentAgents?: boolean;
}

export interface ProjectRuntimeControlInput {
  id: string;
}

export interface ManagedProjectRecord {
  id: string;
  displayName: string | null;
  enabled: boolean;
  runtimeRunning: boolean;
  fatalError: FatalProjectError | null;
  projectSlug: string;
  githubRepository: string | null;
  agentProvider: AgentProvider;
  agentModel: string;
  usesGlobalAgentProvider: boolean;
  usesGlobalAgentModel: boolean;
  workflowDirectory: string;
  workflowPath: string;
  envFilePath: string;
  pollingIntervalMs: number;
  maxConcurrentAgents: number;
  hasLinearApiKey: boolean;
  hasXaiApiKey: boolean;
  hasGithubToken: boolean;
  usesGlobalLinearApiKey: boolean;
  usesGlobalXaiApiKey: boolean;
  usesGlobalGithubToken: boolean;
  usesGlobalPollingIntervalMs: boolean;
  usesGlobalMaxConcurrentAgents: boolean;
}
