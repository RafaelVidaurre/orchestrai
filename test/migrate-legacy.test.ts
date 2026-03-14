import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyWorkflows } from "../src/migrate-legacy";
import { readOrchestraiConfig } from "../src/orchestrai-config";
import { createProjectSetup } from "../src/project-setup";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy migration", () => {
  it("migrates workflow projects into orchestrai.config.ts and prompt files", async () => {
    const legacyRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrai-legacy-"));
    const nextRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrai-next-"));
    tempRoots.push(legacyRoot, nextRoot);

    await writeFile(
      path.join(legacyRoot, ".env.local"),
      [
        'ORCHESTRAI_DEFAULT_AGENT_PROVIDER="claude"',
        'ORCHESTRAI_DEFAULT_AGENT_MODEL="sonnet"',
        'ORCHESTRAI_DEFAULT_CODEX_REASONING_EFFORT="high"',
        ""
      ].join("\n"),
      "utf8"
    );

    const legacyProject = await createProjectSetup(legacyRoot, {
      displayName: "Legacy Storybook",
      projectSlug: "legacy-storybook",
      githubRepository: "example/legacy-storybook",
      linearApiKey: "lin_legacy",
      xaiApiKey: "xai_legacy",
      githubToken: "gh_legacy",
      agentProvider: "grok",
      useGlobalAgentProvider: false
    });

    const report = await migrateLegacyWorkflows(legacyRoot, nextRoot, {});
    const migratedConfig = await readOrchestraiConfig(nextRoot);
    const prompt = await readFile(path.join(nextRoot, "prompts", "legacy-storybook.md"), "utf8");
    const migratedEnv = await readFile(path.join(nextRoot, ".orchestrai", "projects", "legacy-storybook.env"), "utf8");

    expect(report.migratedProjects).toHaveLength(1);
    expect(report.migratedProjects[0].workflowPath).toBe(legacyProject.workflowPath);
    expect(migratedConfig.defaults.agentProvider).toBe("claude");
    expect(migratedConfig.defaults.agentModel).toBe("sonnet");
    expect(migratedConfig.projects[0].agent?.provider).toBe("grok");
    expect(migratedConfig.projects[0].projectSlug).toBe("legacy-storybook");
    expect(prompt).toContain("## Step 0: Determine current ticket state and route");
    expect(migratedEnv).toContain('LINEAR_API_KEY="lin_legacy"');
    expect(migratedEnv).toContain('GITHUB_TOKEN="gh_legacy"');
  });
});
