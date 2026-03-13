import path from "node:path";

import type { ServiceConfig, WorkflowDefinition } from "./domain";
import { ServiceError } from "./errors";
import { DEFAULT_WORKSPACE_ROOT, expandPathLikeValue, normalizeState, resolveSecretValue } from "./utils";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_CODEX_COMMAND =
  "codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=xhigh app-server";
const DEFAULT_APPROVAL_POLICY = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true
  }
} as const;

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
  const codex = asObject(root.codex);
  const server = asObject(root.server);

  const workspaceRootValue =
    typeof workspace.root === "string" && workspace.root.length > 0 ? workspace.root : DEFAULT_WORKSPACE_ROOT;
  const activeStates = applyWorkflowSemanticAdjustments(
    coerceStringArray(tracker.active_states, DEFAULT_ACTIVE_STATES),
    workflow.prompt_template
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
    codex: {
      command:
        typeof codex.command === "string" && codex.command.trim().length > 0 ? codex.command.trim() : DEFAULT_CODEX_COMMAND,
      approvalPolicy: codex.approval_policy ?? DEFAULT_APPROVAL_POLICY,
      threadSandbox: codex.thread_sandbox ?? "workspace-write",
      turnSandboxPolicy: codex.turn_sandbox_policy ?? null,
      turnTimeoutMs: coercePositiveInteger(codex.turn_timeout_ms, 3600000),
      readTimeoutMs: coercePositiveInteger(codex.read_timeout_ms, 5000),
      stallTimeoutMs: coerceInteger(codex.stall_timeout_ms, 300000)
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

  if (!config.codex.command) {
    throw new ServiceError("missing_codex_command", "codex.command must be configured");
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
