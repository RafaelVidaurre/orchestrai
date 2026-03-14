import type { ProviderModelCatalog } from "../domain";
import { ServiceError } from "../errors";
import { ClaudeCliSession } from "../claude";
import type { AgentProviderPlugin } from "../plugin-sdk";

const MODELS = [
  { value: "default", label: "default" },
  { value: "sonnet", label: "sonnet" },
  { value: "opus", label: "opus" },
  { value: "haiku", label: "haiku" },
  { value: "sonnet[1m]", label: "sonnet[1m]" },
  { value: "opusplan", label: "opusplan" }
] as const;

const DEFAULT_CLAUDE_OPTIONS = {
  command: "claude",
  permissionMode: "bypassPermissions",
  maxBudgetUsd: null
} as const;

export const claudeProviderPlugin: AgentProviderPlugin = {
  id: "claude",
  displayName: "Claude CLI",
  defaultModel: "default",
  defaultOptions: DEFAULT_CLAUDE_OPTIONS,
  listModels(): ProviderModelCatalog {
    return {
      provider: "claude",
      models: [...MODELS],
      source: "static",
      warning: null
    };
  },
  createSession(config, workspacePath, env, logger, onEvent) {
    return new ClaudeCliSession(config, workspacePath, env, logger, onEvent);
  },
  validateConfig(config) {
    if (!config.claude.command) {
      throw new ServiceError("missing_claude_command", "claude.command must be configured");
    }
  },
  compileWorkflowSections(input) {
    return {
      claude: {
        command: asNonEmptyString(input.options.command) ?? DEFAULT_CLAUDE_OPTIONS.command,
        permission_mode: asNonEmptyString(input.options.permissionMode) ?? DEFAULT_CLAUDE_OPTIONS.permissionMode,
        max_budget_usd: typeof input.options.maxBudgetUsd === "number" ? input.options.maxBudgetUsd : null
      }
    };
  },
  pricing: {
    sonnet: {
      inputUsdPer1M: 3,
      cachedInputUsdPer1M: 0.3,
      cacheCreationUsdPer1M: 3.75,
      outputUsdPer1M: 15,
      source: "estimated_alias"
    },
    "sonnet[1m]": {
      inputUsdPer1M: 3,
      cachedInputUsdPer1M: 0.3,
      cacheCreationUsdPer1M: 3.75,
      outputUsdPer1M: 15,
      source: "estimated_alias"
    },
    opus: {
      inputUsdPer1M: 15,
      cachedInputUsdPer1M: 1.5,
      cacheCreationUsdPer1M: 18.75,
      outputUsdPer1M: 75,
      source: "estimated_alias"
    },
    opusplan: {
      inputUsdPer1M: 15,
      cachedInputUsdPer1M: 1.5,
      cacheCreationUsdPer1M: 18.75,
      outputUsdPer1M: 75,
      source: "estimated_alias"
    },
    haiku: {
      inputUsdPer1M: 0.8,
      cachedInputUsdPer1M: 0.08,
      cacheCreationUsdPer1M: 1,
      outputUsdPer1M: 4,
      source: "estimated_alias"
    }
  }
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
