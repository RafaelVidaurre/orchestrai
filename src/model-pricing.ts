import type { AgentProvider, AgentUsageSnapshot, UsageCostSource } from "./domain";

type ModelPricing = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  cacheCreationUsdPer1M?: number;
  source: Exclude<UsageCostSource, "actual" | "unknown">;
};

// The built-in catalog intentionally covers only models the app exposes directly.
// When a provider reports actual spend, that always wins over these estimates.
const EXACT_PRICING: Record<AgentProvider, Record<string, ModelPricing>> = {
  codex: {
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
  },
  claude: {},
  grok: {
    "grok-code-fast-1": {
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 1.5,
      source: "official"
    },
    "grok-4-fast-reasoning": {
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 3,
      source: "official"
    }
  }
};

const CLAUDE_ALIAS_PRICING: Record<string, ModelPricing> = {
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
};

export function resolveModelPricing(provider: AgentProvider, model: string): ModelPricing | null {
  const normalized = model.trim();
  if (!normalized) {
    return null;
  }

  const exact = EXACT_PRICING[provider][normalized];
  if (exact) {
    return exact;
  }

  if (provider === "claude") {
    const alias = CLAUDE_ALIAS_PRICING[normalized];
    if (alias) {
      return alias;
    }
  }

  return null;
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
