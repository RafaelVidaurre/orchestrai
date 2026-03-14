import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultOrchestraiConfig,
  readOrchestraiConfig,
  renderOrchestraiConfig,
  writeOrchestraiConfig
} from "../src/orchestrai-config";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orchestrai config", () => {
  it("returns the default config when no config file exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrai-config-default-"));
    tempRoots.push(root);

    await expect(readOrchestraiConfig(root)).resolves.toEqual(defaultOrchestraiConfig());
  });

  it("writes and reads a config roundtrip", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrai-config-roundtrip-"));
    tempRoots.push(root);

    await writeOrchestraiConfig(root, {
      version: 2,
      defaults: {
        pollingIntervalMs: 15000,
        maxConcurrentAgents: 4,
        agentProvider: "claude",
        agentModel: "sonnet",
        providerOptions: {
          codex: { reasoningEffort: "high" },
          claude: { permissionMode: "bypassPermissions" }
        }
      },
      projects: [
        {
          id: "storybook",
          displayName: "Storybook",
          enabled: true,
          projectSlug: "storybook",
          githubRepository: "example/storybook",
          source: {
            kind: "existingPath",
            path: "/tmp/storybook"
          },
          promptPath: "prompts/storybook.md",
          secrets: {
            useGlobalLinearApiKey: true,
            useGlobalXaiApiKey: true,
            useGlobalGithubToken: false
          }
        }
      ]
    });

    const loaded = await readOrchestraiConfig(root);
    expect(loaded.defaults.agentProvider).toBe("claude");
    expect(loaded.defaults.providerOptions.codex?.reasoningEffort).toBe("high");
    expect(loaded.projects[0].source).toEqual({
      kind: "existingPath",
      path: "/tmp/storybook"
    });
    expect(loaded.projects[0].tracker?.endpoint).toBe("https://api.linear.app/graphql");
    expect(loaded.projects[0].workspace?.root).toBe(".orchestrai/workspaces");
  });

  it("loads a config authored with defineConfig imports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrai-config-import-"));
    tempRoots.push(root);

    await writeFile(
      path.join(root, "orchestrai.config.ts"),
      [
        'import { defineConfig } from "orchestrai/config";',
        "",
        "export default defineConfig({",
        '  version: 2,',
        "  defaults: {",
        '    pollingIntervalMs: 20000,',
        '    maxConcurrentAgents: 6,',
        '    agentProvider: "custom-provider",',
        '    agentModel: "custom-model",',
        "    providerOptions: {}",
        "  },",
        "  projects: []",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const loaded = await readOrchestraiConfig(root);
    expect(loaded.defaults.agentProvider).toBe("custom-provider");
    expect(loaded.defaults.agentModel).toBe("custom-model");
  });

  it("renders a data-only config file with defineConfig", () => {
    const rendered = renderOrchestraiConfig(defaultOrchestraiConfig());
    expect(rendered).toContain('import { defineConfig } from "orchestrai/config";');
    expect(rendered).toContain('"agentProvider": "codex"');
    expect(rendered).toContain("export default defineConfig(");
  });
});
