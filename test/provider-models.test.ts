import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listProviderModels } from "../src/provider-models";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider model catalogs", () => {
  it("returns static model lists for non-Grok providers", async () => {
    const catalog = await listProviderModels({ provider: "claude" });

    expect(catalog.source).toBe("static");
    expect(catalog.models.map((model) => model.value)).toContain("sonnet");
  });

  it("returns a fallback catalog when no XAI key is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "provider-models-"));
    tempRoots.push(root);

    const catalog = await listProviderModels(
      {
        provider: "grok",
        useStoredKey: true
      },
      {
        baseEnv: {},
        projectsRoot: root
      }
    );

    expect(catalog.source).toBe("dynamic_fallback");
    expect(catalog.warning).toContain("XAI API key");
    expect(catalog.models.map((model) => model.value)).toContain("grok-code-fast-1");
  });

  it("loads the live Grok model list when an API key is provided", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: "grok-4-fast-reasoning" },
            { id: "grok-code-fast-1" }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await listProviderModels({
      provider: "grok",
      xaiApiKey: "xai-test-key",
      useStoredKey: false
    });

    expect(catalog.source).toBe("dynamic");
    expect(catalog.warning).toBeNull();
    expect(catalog.models.map((model) => model.value)).toEqual([
      "grok-4-fast-reasoning",
      "grok-code-fast-1"
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
