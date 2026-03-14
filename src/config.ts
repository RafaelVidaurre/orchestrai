import path from "node:path";

import {
  coerceCodexReasoningEffort,
  type AgentProvider,
  type CodexReasoningEffort,
  type ServiceConfig,
  type WorkflowDefinition
} from "./domain";
import { ServiceError } from "./errors";
import { DEFAULT_WORKSPACE_ROOT, expandPathLikeValue, normalizeState, resolveSecretValue } from "./utils";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
export const DEFAULT_CODEX_COMMAND =
  "codex --config shell_environment_policy.inherit=all app-server";
export const DEFAULT_CLAUDE_COMMAND = "claude";
export const DEFAULT_GROK_MODEL = "grok-code-fast-1";
export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "medium";
const DEFAULT_AGENT_PROVIDER: AgentProvider = "codex";
const DEFAULT_AGENT_MODEL = "";
const DEFAULT_APPROVAL_POLICY = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true
  }
} as const;
const DEFAULT_CLAUDE_PERMISSION_MODE = "bypassPermissions";
const DEFAULT_GROK_MAX_TOOL_ROUNDS = 24;
const DEFAULT_GROK_COMMAND_TIMEOUT_MS = 120000;
const DEFAULT_GROK_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 3600000;
const DEFAULT_READ_TIMEOUT_MS = 5000;
const DEFAULT_STALL_TIMEOUT_MS = 300000;

export function buildServiceConfig(
  workflowPath: string,
  workflow: WorkflowDefinition,
  env: NodeJS.ProcessEnv = process.env
): ServiceConfig {
  const root = asObject(workflow.config);
  const tracker = asObject(root.tracker);
  const project = asObject(root.project);
  const polling = asObject(root.polling);
  const workspace = asObject(root.workspace);
  const hooks = asObject(root.hooks);
  const agent = asObject(root.agent);
  const runtime = asObject(root.runtime);
  const codex = asObject(root.codex);
  const claude = asObject(root.claude);
  const grok = asObject(root.grok);
  const server = asObject(root.server);

  const workspaceRootValue =
    typeof workspace.root === "string" && workspace.root.length > 0 ? workspace.root : DEFAULT_WORKSPACE_ROOT;
  const activeStates = applyWorkflowSemanticAdjustments(
    coerceStringArray(tracker.active_states, DEFAULT_ACTIVE_STATES),
    workflow.prompt_template
  );
  const defaultProvider = coerceAgentProvider(env.ORCHESTRAI_DEFAULT_AGENT_PROVIDER, DEFAULT_AGENT_PROVIDER);
  const provider = coerceAgentProvider(runtime.provider, defaultProvider);
  const model = resolveRuntimeModel({ runtime, codex, claude, grok, provider, env });
  const turnTimeoutMs = coercePositiveInteger(
    runtime.turn_timeout_ms,
    coercePositiveInteger(
      provider === "claude"
        ? claude.turn_timeout_ms
        : provider === "grok"
          ? grok.turn_timeout_ms
          : codex.turn_timeout_ms,
      DEFAULT_TURN_TIMEOUT_MS
    )
  );
  const readTimeoutMs = coercePositiveInteger(
    runtime.read_timeout_ms,
    coercePositiveInteger(
      provider === "claude"
        ? claude.read_timeout_ms
        : provider === "grok"
          ? grok.read_timeout_ms
          : codex.read_timeout_ms,
      DEFAULT_READ_TIMEOUT_MS
    )
  );
  const stallTimeoutMs = coerceInteger(
    runtime.stall_timeout_ms,
    coerceInteger(
      provider === "claude"
        ? claude.stall_timeout_ms
        : provider === "grok"
          ? grok.stall_timeout_ms
          : codex.stall_timeout_ms,
      DEFAULT_STALL_TIMEOUT_MS
    )
  );

  return {
    workflowPath,
    project: {
      displayName: coerceOptionalString(project.name),
      enabled: coerceBoolean(project.enabled, true)
    },
    tracker: {
      kind: (typeof tracker.kind === "string" ? tracker.kind : "linear") as "linear",
      endpoint: typeof tracker.endpoint === "string" && tracker.endpoint.length > 0 ? tracker.endpoint : DEFAULT_LINEAR_ENDPOINT,
      apiKey: resolveSecretValue(tracker.api_key, env, "LINEAR_API_KEY"),
      projectSlug: resolveSecretValue(tracker.project_slug, env, "PROJECT_SLUG").trim(),
      activeStates,
      terminalStates: coerceStringArray(tracker.terminal_states, DEFAULT_TERMINAL_STATES)
    },
    polling: {
      intervalMs: coerceInteger(
        polling.interval_ms,
        coerceInteger(env.ORCHESTRAI_DEFAULT_POLLING_INTERVAL_MS, 30000)
      )
    },
    workspace: {
      root: expandPathLikeValue(workspaceRootValue, env)
    },
    hooks: {
      afterCreate: coerceOptionalString(hooks.after_create),
      beforeRun: coerceOptionalString(hooks.before_run),
      afterRun: coerceOptionalString(hooks.after_run),
      beforeRemove: coerceOptionalString(hooks.before_remove),
      timeoutMs: coercePositiveInteger(hooks.timeout_ms, 60000)
    },
    agent: {
      maxConcurrentAgents: coercePositiveInteger(
        agent.max_concurrent_agents,
        coercePositiveInteger(env.ORCHESTRAI_DEFAULT_MAX_CONCURRENT_AGENTS, 10)
      ),
      maxRetryBackoffMs: coercePositiveInteger(agent.max_retry_backoff_ms, 300000),
      maxConcurrentAgentsByState: coerceStateLimitMap(agent.max_concurrent_agents_by_state),
      maxTurns: coercePositiveInteger(agent.max_turns, 20)
    },
    runtime: {
      provider,
      model,
      turnTimeoutMs,
      readTimeoutMs,
      stallTimeoutMs
    },
    codex: {
      command:
        typeof codex.command === "string" && codex.command.trim().length > 0 ? codex.command.trim() : DEFAULT_CODEX_COMMAND,
      reasoningEffort: resolveCodexReasoningEffort(codex.reasoning_effort, env),
      approvalPolicy: codex.approval_policy ?? DEFAULT_APPROVAL_POLICY,
      threadSandbox: codex.thread_sandbox ?? "danger-full-access",
      turnSandboxPolicy: codex.turn_sandbox_policy ?? null
    },
    claude: {
      command:
        typeof claude.command === "string" && claude.command.trim().length > 0 ? claude.command.trim() : DEFAULT_CLAUDE_COMMAND,
      permissionMode:
        typeof claude.permission_mode === "string" && claude.permission_mode.trim().length > 0
          ? claude.permission_mode.trim()
          : DEFAULT_CLAUDE_PERMISSION_MODE,
      maxBudgetUsd: coerceNullableNumber(claude.max_budget_usd)
    },
    grok: {
      apiKey: resolveSecretValue(
        typeof grok.api_key === "string" && grok.api_key.trim().length > 0 ? grok.api_key : "$XAI_API_KEY",
        env,
        "XAI_API_KEY"
      ).trim(),
      baseUrl:
        typeof grok.base_url === "string" && grok.base_url.trim().length > 0
          ? grok.base_url.trim().replace(/\/+$/, "")
          : DEFAULT_GROK_BASE_URL,
      maxToolRounds: coercePositiveInteger(grok.max_tool_rounds, DEFAULT_GROK_MAX_TOOL_ROUNDS),
      commandTimeoutMs: coercePositiveInteger(grok.command_timeout_ms, DEFAULT_GROK_COMMAND_TIMEOUT_MS),
      maxOutputBytes: coercePositiveInteger(grok.max_output_bytes, DEFAULT_GROK_MAX_OUTPUT_BYTES)
    },
    server: {
      port: coerceInteger(server.port, 4318),
      host: typeof server.host === "string" && server.host.trim().length > 0 ? server.host.trim() : "127.0.0.1"
    }
  };
}

export function validateDispatchConfig(config: ServiceConfig): void {
  if (config.tracker.kind !== "linear") {
    throw new ServiceError("unsupported_tracker_kind", `Unsupported tracker kind: ${config.tracker.kind}`);
  }

  if (!config.tracker.apiKey) {
    throw new ServiceError("missing_tracker_api_key", "Linear API key is missing");
  }

  if (!config.tracker.projectSlug) {
    throw new ServiceError("missing_tracker_project_slug", "Linear project slug is missing");
  }

  if (config.runtime.provider === "codex" && !config.codex.command) {
    throw new ServiceError("missing_codex_command", "codex.command must be configured");
  }

  if (config.runtime.provider === "claude" && !config.claude.command) {
    throw new ServiceError("missing_claude_command", "claude.command must be configured");
  }

  if (config.runtime.provider === "grok" && !config.grok.apiKey) {
    throw new ServiceError("missing_grok_api_key", "grok.api_key or XAI_API_KEY must be configured");
  }

  if (!path.isAbsolute(config.workspace.root)) {
    throw new ServiceError("invalid_workspace_root", "workspace.root must resolve to an absolute path", {
      workspace_root: config.workspace.root
    });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function coerceInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function coercePositiveInteger(value: unknown, fallback: number): number {
  const next = coerceInteger(value, fallback);
  return next > 0 ? next : fallback;
}

function coerceNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function coerceOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  return fallback;
}

function coerceStateLimitMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output: Record<string, number> = {};
  for (const [state, rawLimit] of Object.entries(value as Record<string, unknown>)) {
    const limit = coercePositiveInteger(rawLimit, -1);
    if (limit > 0) {
      output[normalizeState(state)] = limit;
    }
  }

  return output;
}

function applyWorkflowSemanticAdjustments(activeStates: string[], promptTemplate: string): string[] {
  const requiredStates = ["Human Review", "Merging", "Rework"].filter((requiredState) => {
    const pattern = new RegExp(`\\b${requiredState.replace(/\s+/g, "\\s+")}\\b`);
    return pattern.test(promptTemplate);
  });

  if (requiredStates.length === 0) {
    return activeStates;
  }

  return requiredStates.reduce<string[]>((nextStates, requiredState) => {
    if (nextStates.some((state) => normalizeState(state) === normalizeState(requiredState))) {
      return nextStates;
    }

    return [...nextStates, requiredState];
  }, activeStates);
}

function coerceAgentProvider(value: unknown, fallback: AgentProvider): AgentProvider {
  return value === "claude" || value === "codex" || value === "grok" ? value : fallback;
}

function resolveRuntimeModel(params: {
  runtime: Record<string, unknown>;
  codex: Record<string, unknown>;
  claude: Record<string, unknown>;
  grok: Record<string, unknown>;
  provider: AgentProvider;
  env: NodeJS.ProcessEnv;
}): string {
  const envKey = "ORCHESTRAI_DEFAULT_AGENT_MODEL";
  const legacyCodexEnvKey = "ORCHESTRAI_DEFAULT_CODEX_MODEL";

  if (typeof params.runtime.model === "string" && params.runtime.model.trim().length > 0) {
    return resolveSecretValue(params.runtime.model, params.env, envKey).trim();
  }

  if (params.provider === "codex" && typeof params.codex.model === "string" && params.codex.model.trim().length > 0) {
    return resolveSecretValue(params.codex.model, params.env, legacyCodexEnvKey).trim();
  }

  if (params.provider === "claude" && typeof params.claude.model === "string" && params.claude.model.trim().length > 0) {
    return resolveSecretValue(params.claude.model, params.env, envKey).trim();
  }

  if (params.provider === "grok" && typeof params.grok.model === "string" && params.grok.model.trim().length > 0) {
    return resolveSecretValue(params.grok.model, params.env, envKey).trim();
  }

  const fromAgentDefault = resolveSecretValue(`$${envKey}`, params.env, envKey).trim();
  if (fromAgentDefault) {
    return fromAgentDefault;
  }

  if (params.provider === "codex") {
    return resolveSecretValue(`$${legacyCodexEnvKey}`, params.env, legacyCodexEnvKey).trim() || DEFAULT_AGENT_MODEL;
  }

  if (params.provider === "grok") {
    return DEFAULT_GROK_MODEL;
  }

  return DEFAULT_AGENT_MODEL;
}

function resolveCodexReasoningEffort(value: unknown, env: NodeJS.ProcessEnv): CodexReasoningEffort {
  if (typeof value === "string" && value.trim().length > 0) {
    return coerceCodexReasoningEffort(
      resolveSecretValue(value, env, "ORCHESTRAI_DEFAULT_CODEX_REASONING_EFFORT").trim(),
      DEFAULT_CODEX_REASONING_EFFORT
    );
  }

  const fromEnv = resolveSecretValue("$ORCHESTRAI_DEFAULT_CODEX_REASONING_EFFORT", env, "ORCHESTRAI_DEFAULT_CODEX_REASONING_EFFORT").trim();
  return coerceCodexReasoningEffort(fromEnv, DEFAULT_CODEX_REASONING_EFFORT);
}
