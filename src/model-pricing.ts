import type { AgentProvider, AgentUsageSnapshot, UsageCostSource } from "./domain";
import { getActiveProviderRegistry } from "./provider-registry";
import type { ProviderPricing } from "./plugin-sdk";

export function resolveModelPricing(provider: AgentProvider, model: string): ProviderPricing | null {
  const normalized = model.trim();
  if (!normalized) {
    return null;
  }

  return getActiveProviderRegistry().maybeGet(provider)?.pricing?.[normalized] ?? null;
}

export function estimateUsageCost(
  provider: AgentProvider,
  model: string,
  usage: AgentUsageSnapshot
): { costUsd: number | null; costSource: UsageCostSource } {
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) {
    return {
      costUsd: roundUsd(usage.cost_usd),
      costSource: "actual"
    };
  }

  const pricing = resolveModelPricing(provider, model);
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
