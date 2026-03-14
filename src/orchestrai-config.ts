import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { transform } from "esbuild";

export const ORCHESTRAI_CONFIG_FILE = "orchestrai.config.ts";
export const ORCHESTRAI_CONFIG_VERSION = 2;
type AgentProvider = string;
type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | (string & {});

export interface ProjectCloneSource {
  kind: "clone";
  repository: string;
}

export interface ProjectExistingPathSource {
  kind: "existingPath";
  path: string;
}

export type ProjectSource = ProjectCloneSource | ProjectExistingPathSource;

export interface OrchestraiProjectHooksConfig {
  afterCreate?: string | null;
  beforeRun?: string | null;
  afterRun?: string | null;
  beforeRemove?: string | null;
  timeoutMs?: number | null;
}

export interface OrchestraiProjectSecretsConfig {
  useGlobalLinearApiKey: boolean;
  useGlobalXaiApiKey: boolean;
  useGlobalGithubToken: boolean;
}

export interface OrchestraiProjectAgentConfig {
  provider?: AgentProvider | null;
  model?: string | null;
  options?: Record<string, unknown> | null;
  maxConcurrentAgents?: number | null;
  maxTurns?: number | null;
  maxRetryBackoffMs?: number | null;
}

export interface OrchestraiProjectConfig {
  id: string;
  displayName: string | null;
  enabled: boolean;
  projectSlug: string;
  githubRepository: string | null;
  source: ProjectSource;
  tracker?: {
    kind?: "linear";
    endpoint?: string;
  };
  workspace?: {
    root?: string;
  };
  hooks?: OrchestraiProjectHooksConfig;
  agent?: OrchestraiProjectAgentConfig;
  pollingIntervalMs?: number | null;
  promptPath: string;
  secrets: OrchestraiProjectSecretsConfig;
  telemetry?: {
    monthlyBudgetUsd?: number | null;
  };
}

export interface OrchestraiDefaultsConfig {
  pollingIntervalMs: number;
  maxConcurrentAgents: number;
  agentProvider: AgentProvider;
  agentModel: string;
  providerOptions: Record<string, Record<string, unknown>>;
}

export interface OrchestraiConfig {
  version: 2;
  defaults: OrchestraiDefaultsConfig;
  projects: OrchestraiProjectConfig[];
}

export function defineConfig(config: OrchestraiConfig): OrchestraiConfig {
  return normalizeOrchestraiConfig(config);
}

export function orchestraiConfigPath(projectsRoot: string): string {
  return path.join(path.resolve(projectsRoot), ORCHESTRAI_CONFIG_FILE);
}

export function defaultOrchestraiConfig(): OrchestraiConfig {
  return {
    version: ORCHESTRAI_CONFIG_VERSION,
    defaults: {
      pollingIntervalMs: 30000,
      maxConcurrentAgents: 10,
      agentProvider: "codex",
      agentModel: "",
      providerOptions: {
        codex: {
          reasoningEffort: "medium" satisfies CodexReasoningEffort
        }
      }
    },
    projects: []
  };
}

export async function readOrchestraiConfig(projectsRoot: string): Promise<OrchestraiConfig> {
  const filePath = orchestraiConfigPath(projectsRoot);
  const content = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!content) {
    return defaultOrchestraiConfig();
  }

  const transformed = await transform(content, {
    loader: "ts",
    format: "cjs",
    target: "node22"
  });

  const module = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier === "orchestrai/config" || specifier === "@orchestrai/plugin-sdk") {
        return {
          defineConfig
        };
      }
      throw new Error(`Unsupported import in orchestrai.config.ts: ${specifier}`);
    }
  };
  vm.runInNewContext(transformed.code, sandbox, {
    filename: filePath
  });

  const raw = (module.exports.default ?? module.exports) as OrchestraiConfig;
  return normalizeOrchestraiConfig(raw);
}

export async function writeOrchestraiConfig(projectsRoot: string, config: OrchestraiConfig): Promise<void> {
  const normalized = normalizeOrchestraiConfig(config);
  const content = renderOrchestraiConfig(normalized);
  await writeFile(orchestraiConfigPath(projectsRoot), content, "utf8");
}

export function renderOrchestraiConfig(config: OrchestraiConfig): string {
  return [
    'import { defineConfig } from "orchestrai/config";',
    "",
    "export default defineConfig(",
    `${JSON.stringify(config, null, 2)}`,
    ");",
    ""
  ].join("\n");
}

export function normalizeOrchestraiConfig(input: OrchestraiConfig): OrchestraiConfig {
  const defaults = defaultOrchestraiConfig();
  return {
    version: ORCHESTRAI_CONFIG_VERSION,
    defaults: {
      pollingIntervalMs: coercePositiveInt(input?.defaults?.pollingIntervalMs, defaults.defaults.pollingIntervalMs),
      maxConcurrentAgents: coercePositiveInt(
        input?.defaults?.maxConcurrentAgents,
        defaults.defaults.maxConcurrentAgents
      ),
      agentProvider: coerceString(input?.defaults?.agentProvider, defaults.defaults.agentProvider),
      agentModel: coerceString(input?.defaults?.agentModel, defaults.defaults.agentModel),
      providerOptions: normalizeProviderOptions(input?.defaults?.providerOptions, defaults.defaults.providerOptions)
    },
    projects: Array.isArray(input?.projects) ? input.projects.map(normalizeProjectConfig) : []
  };
}

function normalizeProjectConfig(input: OrchestraiProjectConfig): OrchestraiProjectConfig {
  return {
    id: coerceRequiredString(input?.id, "project"),
    displayName: typeof input?.displayName === "string" ? input.displayName : null,
    enabled: input?.enabled !== false,
    projectSlug: coerceRequiredString(input?.projectSlug, "project"),
    githubRepository: typeof input?.githubRepository === "string" && input.githubRepository.trim().length > 0 ? input.githubRepository.trim() : null,
    source: normalizeProjectSource(input?.source),
    tracker: {
      kind: "linear",
      endpoint:
        typeof input?.tracker?.endpoint === "string" && input.tracker.endpoint.trim().length > 0
          ? input.tracker.endpoint.trim()
          : "https://api.linear.app/graphql"
    },
    workspace: {
      root:
        typeof input?.workspace?.root === "string" && input.workspace.root.trim().length > 0
          ? input.workspace.root.trim()
          : ".orchestrai/workspaces"
    },
    hooks: {
      afterCreate: normalizeOptionalString(input?.hooks?.afterCreate),
      beforeRun: normalizeOptionalString(input?.hooks?.beforeRun),
      afterRun: normalizeOptionalString(input?.hooks?.afterRun),
      beforeRemove: normalizeOptionalString(input?.hooks?.beforeRemove),
      timeoutMs: coerceNullablePositiveInt(input?.hooks?.timeoutMs)
    },
    agent: {
      provider: typeof input?.agent?.provider === "string" ? input.agent.provider.trim() : null,
      model: normalizeOptionalString(input?.agent?.model),
      options: normalizeLooseObject(input?.agent?.options),
      maxConcurrentAgents: coerceNullablePositiveInt(input?.agent?.maxConcurrentAgents),
      maxTurns: coerceNullablePositiveInt(input?.agent?.maxTurns),
      maxRetryBackoffMs: coerceNullablePositiveInt(input?.agent?.maxRetryBackoffMs)
    },
    pollingIntervalMs: coerceNullablePositiveInt(input?.pollingIntervalMs),
    promptPath: coerceRequiredString(input?.promptPath, "promptPath"),
    secrets: {
      useGlobalLinearApiKey: input?.secrets?.useGlobalLinearApiKey !== false,
      useGlobalXaiApiKey: input?.secrets?.useGlobalXaiApiKey !== false,
      useGlobalGithubToken: input?.secrets?.useGlobalGithubToken !== false
    },
    telemetry: {
      monthlyBudgetUsd:
        typeof input?.telemetry?.monthlyBudgetUsd === "number" && Number.isFinite(input.telemetry.monthlyBudgetUsd)
          ? input.telemetry.monthlyBudgetUsd
          : null
    }
  };
}

function normalizeProjectSource(input: ProjectSource | undefined): ProjectSource {
  if (input && input.kind === "existingPath") {
    return {
      kind: "existingPath",
      path: coerceRequiredString(input.path, "source.path")
    };
  }

  return {
    kind: "clone",
    repository: input && input.kind === "clone" ? coerceRequiredString(input.repository, "source.repository") : ""
  };
}

function normalizeProviderOptions(
  input: Record<string, Record<string, unknown>> | undefined,
  fallback: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fallback;
  }

  return Object.fromEntries(
    Object.entries(input).map(([provider, value]) => [provider, normalizeLooseObject(value)])
  );
}

function normalizeLooseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function coercePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function coerceNullablePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function coerceRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`${label} is required`);
}
