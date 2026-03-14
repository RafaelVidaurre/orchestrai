import type { ProviderModelCatalog } from "../domain";
import { ServiceError } from "../errors";
import { CodexAppServerSession } from "../codex";
import type { AgentProviderPlugin } from "../plugin-sdk";

const MODELS = [
  { value: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
  { value: "gpt-5.1-codex", label: "GPT-5.1-Codex" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex mini" },
  { value: "codex-mini-latest", label: "codex-mini-latest" },
  { value: "o4-mini", label: "o4-mini" }
] as const;

const DEFAULT_CODEX_OPTIONS = {
  command: "codex --config shell_environment_policy.inherit=all app-server",
  reasoningEffort: "medium",
  approvalPolicy: "never",
  threadSandbox: "danger-full-access",
  turnSandboxPolicy: {
    type: "dangerFullAccess"
  }
} as const;

export const codexProviderPlugin: AgentProviderPlugin = {
  id: "codex",
  displayName: "Codex",
  defaultModel: "gpt-5.2-codex",
  defaultOptions: DEFAULT_CODEX_OPTIONS,
  listModels(): ProviderModelCatalog {
    return {
      provider: "codex",
      models: [...MODELS],
      source: "static",
      warning: null
    };
  },
  createSession(config, workspacePath, env, logger, onEvent) {
    return new CodexAppServerSession(config, workspacePath, env, logger, onEvent);
  },
  validateConfig(config) {
    if (!config.codex.command) {
      throw new ServiceError("missing_codex_command", "codex.command must be configured");
    }
  },
  compileWorkflowSections(input) {
    return {
      codex: {
        command: asNonEmptyString(input.options.command) ?? DEFAULT_CODEX_OPTIONS.command,
        reasoning_effort: asNonEmptyString(input.options.reasoningEffort) ?? DEFAULT_CODEX_OPTIONS.reasoningEffort,
        approval_policy: input.options.approvalPolicy ?? DEFAULT_CODEX_OPTIONS.approvalPolicy,
        thread_sandbox: input.options.threadSandbox ?? DEFAULT_CODEX_OPTIONS.threadSandbox,
        turn_sandbox_policy: input.options.turnSandboxPolicy ?? DEFAULT_CODEX_OPTIONS.turnSandboxPolicy
      }
    };
  },
  pricing: {
    "gpt-5.2-codex": {
      inputUsdPer1M: 1.5,
      cachedInputUsdPer1M: 0.375,
      outputUsdPer1M: 6,
      source: "official"
    },
    "gpt-5.1-codex": {
      inputUsdPer1M: 1.5,
      cachedInputUsdPer1M: 0.375,
      outputUsdPer1M: 6,
      source: "official"
    },
    "gpt-5.1-codex-mini": {
      inputUsdPer1M: 0.375,
      cachedInputUsdPer1M: 0.1,
      outputUsdPer1M: 1.5,
      source: "official"
    },
    "codex-mini-latest": {
      inputUsdPer1M: 0.375,
      cachedInputUsdPer1M: 0.1,
      outputUsdPer1M: 1.5,
      source: "estimated_alias"
    },
    "o4-mini": {
      inputUsdPer1M: 1.1,
      cachedInputUsdPer1M: 0.275,
      outputUsdPer1M: 4.4,
      source: "official"
    }
  }
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
