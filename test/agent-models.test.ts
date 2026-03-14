import { describe, expect, it } from "vitest";

import { agentModelOptions, isKnownAgentModel } from "../src/agent-models";

describe("agent model catalogs", () => {
  it("returns provider-specific model options", () => {
    expect(agentModelOptions("codex").map((option) => option.value)).toContain("gpt-5.2-codex");
    expect(agentModelOptions("claude").map((option) => option.value)).toContain("sonnet");
    expect(agentModelOptions("grok").map((option) => option.value)).toContain("grok-code-fast-1");
  });

  it("recognizes known models per provider", () => {
    expect(isKnownAgentModel("codex", "o4-mini")).toBe(true);
    expect(isKnownAgentModel("claude", "claude-sonnet-4-6")).toBe(false);
    expect(isKnownAgentModel("grok", "grok-4-1-fast-reasoning")).toBe(true);
  });
});
