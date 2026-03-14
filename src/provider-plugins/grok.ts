import type { AgentModelDescriptor, ProviderModelCatalog } from "../domain";
import { ServiceError } from "../errors";
import { GrokApiSession } from "../grok";
import type { AgentProviderPlugin, ProviderModelCatalogInput } from "../plugin-sdk";

const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
const STATIC_MODELS = [
  { value: "grok-code-fast-1", label: "grok-code-fast-1" },
  { value: "grok-4-1-fast-reasoning", label: "grok-4-1-fast-reasoning" },
  { value: "grok-4-fast-reasoning", label: "grok-4-fast-reasoning" },
  { value: "grok-4.20-beta-latest-non-reasoning", label: "grok-4.20-beta-latest-non-reasoning" }
] as const;

export const grokProviderPlugin: AgentProviderPlugin = {
  id: "grok",
  displayName: "Grok",
  defaultModel: "grok-code-fast-1",
  defaultOptions: {
    apiKeyEnv: "XAI_API_KEY",
    baseUrl: DEFAULT_GROK_BASE_URL,
    maxToolRounds: 24,
    commandTimeoutMs: 120000,
    maxOutputBytes: 64 * 1024
  },
  async listModels(input: ProviderModelCatalogInput): Promise<ProviderModelCatalog> {
    const typedKey = typeof input.typedSecrets?.XAI_API_KEY === "string" ? input.typedSecrets.XAI_API_KEY.trim() : "";
    const apiKey =
      typedKey ||
      (input.useStoredKey === false ? "" : typeof input.baseEnv?.XAI_API_KEY === "string" ? input.baseEnv.XAI_API_KEY.trim() : "");
    const fallback = {
      provider: "grok",
      models: [...STATIC_MODELS],
      source: "dynamic_fallback" as const,
      warning: "Set an XAI API key to load the live Grok model list."
    };

    if (!apiKey) {
      return fallback;
    }

    try {
      const response = await fetch(`${DEFAULT_GROK_BASE_URL}/models`, {
        headers: {
          authorization: `Bearer ${apiKey}`
        }
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        return {
          ...fallback,
          warning: `Live Grok models unavailable: HTTP ${response.status}`
        };
      }

      const models = parseGrokModels(payload);
      return {
        provider: "grok",
        models: models.length > 0 ? models : [...STATIC_MODELS],
        source: models.length > 0 ? "dynamic" : "dynamic_fallback",
        warning: models.length > 0 ? null : "xAI returned no models for the current account. Showing built-in defaults instead."
      };
    } catch (error) {
      return {
        ...fallback,
        warning: `Live Grok models unavailable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  },
  createSession(config, workspacePath, env, logger, onEvent) {
    return new GrokApiSession(config, workspacePath, env, logger, onEvent);
  },
  validateConfig(config) {
    if (!config.grok.apiKey) {
      throw new ServiceError("missing_grok_api_key", "grok.api_key or XAI_API_KEY must be configured");
    }
  },
  compileWorkflowSections(input) {
    return {
      grok: {
        api_key: `$${asNonEmptyString(input.options.apiKeyEnv) ?? "XAI_API_KEY"}`,
        base_url: asNonEmptyString(input.options.baseUrl) ?? DEFAULT_GROK_BASE_URL,
        max_tool_rounds: asPositiveInt(input.options.maxToolRounds) ?? 24,
        command_timeout_ms: asPositiveInt(input.options.commandTimeoutMs) ?? 120000,
        max_output_bytes: asPositiveInt(input.options.maxOutputBytes) ?? 64 * 1024
      }
    };
  },
  pricing: {
    "grok-code-fast-1": {
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 1.5,
      source: "official"
    },
    "grok-4-fast-reasoning": {
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 3,
      source: "official"
    },
    "grok-4-1-fast-reasoning": {
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 3,
      source: "estimated_alias"
    }
  }
};

function parseGrokModels(payload: unknown): AgentModelDescriptor[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const id = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id.trim() : "";
      return id ? ({ value: id, label: id } satisfies AgentModelDescriptor) : null;
    })
    .filter((entry): entry is AgentModelDescriptor => entry !== null)
    .sort((left, right) => left.value.localeCompare(right.value));
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}
