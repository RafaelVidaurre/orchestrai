import { afterEach, describe, expect, it } from "vitest";

import { builtinProviderPlugins } from "../src/provider-plugins";
import type { AgentProviderPlugin, ProviderSession } from "../src/plugin-sdk";
import {
  getActiveProviderRegistry,
  ProviderRegistry,
  setActiveProviderRegistry
} from "../src/provider-registry";

describe("provider registry", () => {
  afterEach(() => {
    setActiveProviderRegistry(new ProviderRegistry(builtinProviderPlugins));
  });

  it("exposes the built-in provider plugins", () => {
    const registry = new ProviderRegistry(builtinProviderPlugins);
    expect(registry.list().map((plugin) => plugin.id)).toEqual(["claude", "codex", "grok"]);
    expect(registry.get("codex").displayName).toBe("Codex");
    expect(registry.maybeGet("missing-provider")).toBeNull();
  });

  it("rejects duplicate provider ids", () => {
    const duplicate = makePlugin("codex");
    expect(() => new ProviderRegistry([...builtinProviderPlugins, duplicate])).toThrow(/Duplicate provider plugin id: codex/);
  });

  it("lets tests swap the active registry", () => {
    const registry = new ProviderRegistry([makePlugin("custom-provider")]);
    setActiveProviderRegistry(registry);

    expect(getActiveProviderRegistry().get("custom-provider").displayName).toBe("CUSTOM-PROVIDER");
  });
});

function makePlugin(id: string): AgentProviderPlugin {
  return {
    id,
    displayName: id.toUpperCase(),
    defaultModel: `${id}-model`,
    defaultOptions: {},
    listModels() {
      return {
        provider: id,
        models: [{ value: `${id}-model`, label: `${id}-model` }],
        source: "static",
        warning: null
      };
    },
    createSession(): ProviderSession {
      return {
        async start() {},
        async runTurn() {},
        async stop() {}
      };
    }
  };
}
