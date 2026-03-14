import type { AgentRuntimeEvent, AgentUsageSnapshot, AgentProvider, ProviderModelCatalog, ServiceConfig } from "./domain";
import type { Logger } from "./logger";

export interface ProviderSession {
  start(): Promise<void>;
  runTurn(prompt: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ProviderModelCatalogInput {
  provider: AgentProvider;
  projectId?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  projectsRoot?: string | null;
  useStoredKey?: boolean;
  typedSecrets?: Record<string, string | null | undefined>;
}

export interface ProviderCompileInput {
  projectId: string;
  model: string;
  options: Record<string, unknown>;
  envFileReferences: {
    linearApiKey: string;
    xaiApiKey: string;
    githubToken: string;
    projectSlug: string;
    githubRepository: string;
    projectSource: string;
  };
}

export interface ProviderPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  cacheCreationUsdPer1M?: number;
  source: "official" | "estimated_alias";
}

export interface AgentProviderPlugin {
  id: AgentProvider;
  displayName: string;
  defaultModel: string;
  defaultOptions: Record<string, unknown>;
  listModels(input: ProviderModelCatalogInput): Promise<ProviderModelCatalog> | ProviderModelCatalog;
  createSession(
    config: ServiceConfig,
    workspacePath: string,
    env: NodeJS.ProcessEnv,
    logger: Logger,
    onEvent: (event: AgentRuntimeEvent) => void
  ): ProviderSession;
  compileWorkflowSections?(input: ProviderCompileInput): Record<string, unknown>;
  validateConfig?(config: ServiceConfig): void;
  doctor?(
    config: ServiceConfig,
    env: NodeJS.ProcessEnv
  ): Promise<Array<{ level: "info" | "warn" | "error"; message: string }>> | Array<{ level: "info" | "warn" | "error"; message: string }>;
  pricing?: Record<string, ProviderPricing>;
}

export function estimatePluginUsageCost(
  plugin: AgentProviderPlugin,
  model: string,
  usage: AgentUsageSnapshot
): { costUsd: number | null; costSource: "actual" | "official" | "estimated_alias" | "unknown" } {
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) {
    return {
      costUsd: roundUsd(usage.cost_usd),
      costSource: "actual"
    };
  }

  const pricing = plugin.pricing?.[model.trim()];
  if (!pricing) {
    return {
      costUsd: null,
      costSource: "unknown"
    };
  }

  const cacheReadTokens = clampTokens(usage.cache_read_input_tokens);
  const cacheCreationTokens = clampTokens(usage.cache_creation_input_tokens);
  const totalInputTokens = clampTokens(usage.input_tokens);
  const uncachedInputTokens = Math.max(totalInputTokens - cacheReadTokens - cacheCreationTokens, 0);
  const outputTokens = clampTokens(usage.output_tokens);
  const costUsd =
    (uncachedInputTokens / 1_000_000) * pricing.inputUsdPer1M +
    (cacheReadTokens / 1_000_000) * (pricing.cachedInputUsdPer1M ?? pricing.inputUsdPer1M) +
    (cacheCreationTokens / 1_000_000) * (pricing.cacheCreationUsdPer1M ?? pricing.inputUsdPer1M) +
    (outputTokens / 1_000_000) * pricing.outputUsdPer1M;

  return {
    costUsd: roundUsd(costUsd),
    costSource: pricing.source
  };
}

function clampTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
