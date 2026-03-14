import { readFile } from "node:fs/promises";
import path from "node:path";

import { agentModelOptions } from "./agent-models";
import { DEFAULT_GROK_BASE_URL, buildServiceConfig } from "./config";
import type { AgentModelDescriptor, ProviderModelCatalog, ProviderModelQuery } from "./domain";
import { loadEnvFiles, loadWorkflowEnv } from "./env";
import { errorMessage } from "./errors";
import { parseWorkflowFile } from "./workflow";

export async function listProviderModels(
  input: ProviderModelQuery,
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    projectsRoot?: string | null;
  } = {}
): Promise<ProviderModelCatalog> {
  if (input.provider !== "grok") {
    return {
      provider: input.provider,
      models: agentModelOptions(input.provider),
      source: "static",
      warning: null
    };
  }

  const staticModels = agentModelOptions("grok");
  const resolved = await resolveGrokContext(input, options.baseEnv ?? process.env, options.projectsRoot ?? null);
  if (!resolved.apiKey) {
    return {
      provider: "grok",
      models: staticModels,
      source: "dynamic_fallback",
      warning: "Set an XAI API key to load the live Grok model list."
    };
  }

  try {
    const response = await fetch(`${resolved.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${resolved.apiKey}`
      }
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail = extractModelApiError(payload);
      return {
        provider: "grok",
        models: staticModels,
        source: "dynamic_fallback",
        warning: detail ? `Live Grok models unavailable: ${detail}` : `Live Grok models unavailable: HTTP ${response.status}`
      };
    }

    const models = parseGrokModels(payload);
    return {
      provider: "grok",
      models: models.length > 0 ? models : staticModels,
      source: models.length > 0 ? "dynamic" : "dynamic_fallback",
      warning: models.length > 0 ? null : "xAI returned no models for the current account. Showing built-in defaults instead."
    };
  } catch (error) {
    return {
      provider: "grok",
      models: staticModels,
      source: "dynamic_fallback",
      warning: `Live Grok models unavailable: ${errorMessage(error)}`
    };
  }
}

async function resolveGrokContext(
  input: ProviderModelQuery,
  baseEnv: NodeJS.ProcessEnv,
  projectsRoot: string | null
): Promise<{ apiKey: string | null; baseUrl: string }> {
  const typedKey = typeof input.xaiApiKey === "string" ? input.xaiApiKey.trim() : "";
  if (typedKey.length > 0) {
    return {
      apiKey: typedKey,
      baseUrl: await resolveGrokBaseUrl(input.projectId ?? null, baseEnv, projectsRoot)
    };
  }

  if (input.useStoredKey === false) {
    return {
      apiKey: null,
      baseUrl: await resolveGrokBaseUrl(input.projectId ?? null, baseEnv, projectsRoot)
    };
  }

  if (input.projectId) {
    const workflowPath = path.resolve(input.projectId);
    const env = await loadWorkflowEnv(path.dirname(workflowPath), baseEnv, undefined, projectsRoot);
    return {
      apiKey: typeof env.XAI_API_KEY === "string" && env.XAI_API_KEY.trim().length > 0 ? env.XAI_API_KEY.trim() : null,
      baseUrl: await resolveGrokBaseUrl(workflowPath, baseEnv, projectsRoot)
    };
  }

  if (projectsRoot) {
    const env = { ...baseEnv };
    await loadEnvFiles(path.resolve(projectsRoot), env);
    return {
      apiKey: typeof env.XAI_API_KEY === "string" && env.XAI_API_KEY.trim().length > 0 ? env.XAI_API_KEY.trim() : null,
      baseUrl: DEFAULT_GROK_BASE_URL
    };
  }

  return {
    apiKey: typeof baseEnv.XAI_API_KEY === "string" && baseEnv.XAI_API_KEY.trim().length > 0 ? baseEnv.XAI_API_KEY.trim() : null,
    baseUrl: DEFAULT_GROK_BASE_URL
  };
}

async function resolveGrokBaseUrl(
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv,
  projectsRoot: string | null
): Promise<string> {
  if (!projectId) {
    return DEFAULT_GROK_BASE_URL;
  }

  const workflowPath = path.resolve(projectId);
  const env = await loadWorkflowEnv(path.dirname(workflowPath), baseEnv, undefined, projectsRoot);
  const definition = parseWorkflowFile(await readFile(workflowPath, "utf8"));
  return buildServiceConfig(workflowPath, definition, env).grok.baseUrl;
}

function parseGrokModels(payload: unknown): AgentModelDescriptor[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }

  const models = data
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const id = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id.trim() : "";
      if (!id) {
        return null;
      }
      return {
        value: id,
        label: id
      } satisfies AgentModelDescriptor;
    })
    .filter((entry): entry is AgentModelDescriptor => entry !== null)
    .sort((left, right) => left.value.localeCompare(right.value));

  return models;
}

function extractModelApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return record.error.trim();
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  if (typeof record.code === "string" && record.code.trim().length > 0) {
    return record.code.trim();
  }
  return null;
}
