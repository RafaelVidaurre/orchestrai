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

export interface CodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ServiceConfig {
  workflowPath: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
}

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
  version: number;
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export type WorkerCancelReason =
  | "stalled"
  | "canceled_non_active"
  | "canceled_terminal"
  | "service_stopping";

export interface CodexUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface CodexRuntimeEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "approval_auto_approved"
    | "unsupported_tool_call"
    | "notification"
    | "other_message"
    | "malformed";
  timestamp: string;
  codexAppServerPid: number | null;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  usage?: CodexUsageSnapshot;
  rateLimits?: unknown;
  message?: string;
}

export interface WorkerSuccessOutcome {
  kind: "normal";
  issue: Issue;
  turnCount: number;
}

export interface WorkerFailureOutcome {
  kind: "failed" | "timed_out" | "stalled" | "canceled_non_active" | "canceled_terminal" | "service_stopping";
  error: string;
  issue: Issue;
  turnCount: number;
}

export type WorkerOutcome = WorkerSuccessOutcome | WorkerFailureOutcome;

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string | null;
}

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  retryAttempt: number | null;
  startedAtMs: number;
  worker: {
    cancel: (reason: WorkerCancelReason) => void;
    result: Promise<WorkerOutcome>;
  };
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: number | null;
  lastCodexEvent: string | null;
  lastCodexTimestampMs: number | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
  cancellingReason: WorkerCancelReason | null;
}

export interface RuntimeTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}
