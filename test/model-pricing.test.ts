import { describe, expect, it } from "vitest";

import { estimateUsageCost, resolveModelPricing } from "../src/model-pricing";

describe("model pricing", () => {
  it("resolves official pricing for known Codex models", () => {
    expect(resolveModelPricing("codex", "gpt-5.2-codex")).toMatchObject({
      inputUsdPer1M: 1.5,
      cachedInputUsdPer1M: 0.375,
      outputUsdPer1M: 6,
      source: "official"
    });
  });

  it("uses provider-reported spend when available", () => {
    expect(
      estimateUsageCost("grok", "grok-4-1-fast-reasoning", {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_usd: 0.012345
      })
    ).toEqual({
      costUsd: 0.012345,
      costSource: "actual"
    });
  });

  it("estimates Claude alias pricing with cache-aware token splits", () => {
    expect(
      estimateUsageCost("claude", "sonnet", {
        input_tokens: 100_000,
        output_tokens: 20_000,
        total_tokens: 120_000,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 10_000
      })
    ).toEqual({
      costUsd: 0.5265,
      costSource: "estimated_alias"
    });
  });

  it("marks unknown models as unpriced", () => {
    expect(
      estimateUsageCost("claude", "default", {
        input_tokens: 1_000,
        output_tokens: 500,
        total_tokens: 1_500
      })
    ).toEqual({
      costUsd: null,
      costSource: "unknown"
    });
  });
});
