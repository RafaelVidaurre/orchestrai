import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigBackedProjectsService } from "../src/config-backed-projects";
import { builtinProviderPlugins } from "../src/provider-plugins";
import { ProviderRegistry } from "../src/provider-registry";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("config-backed projects", () => {
  it("initialization ensures local runtime paths are gitignored", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-backed-projects-gitignore-"));
    tempRoots.push(root);

    const service = new ConfigBackedProjectsService(root, {}, new ProviderRegistry(builtinProviderPlugins));
    await service.initConfig();

    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");

    expect(gitignore).toContain(".orchestrai/");
    expect(gitignore).toContain(".env.local");
    expect(gitignore).toContain("node_modules/");
  });

  it("does not duplicate gitignore entries on repeated initialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-backed-projects-gitignore-repeat-"));
    tempRoots.push(root);

    const service = new ConfigBackedProjectsService(root, {}, new ProviderRegistry(builtinProviderPlugins));
    await service.initConfig();
    await service.initConfig();

    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/u);

    expect(lines.filter((line) => line === ".orchestrai/")).toHaveLength(1);
    expect(lines.filter((line) => line === ".env.local")).toHaveLength(1);
    expect(lines.filter((line) => line === "node_modules/")).toHaveLength(1);
  });

  it("creates config-backed runtime artifacts for an existing local project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-backed-projects-existing-"));
    tempRoots.push(root);

    const service = new ConfigBackedProjectsService(root, {}, new ProviderRegistry(builtinProviderPlugins));
    await service.initConfig();

    const created = await service.createProject({
      displayName: "Storybook",
      projectSlug: "storybook",
      githubRepository: "",
      linearApiKey: "lin_test",
      useGlobalLinearApiKey: false,
      useGlobalXaiApiKey: true,
      useGlobalGithubToken: true,
      useGlobalAgentProvider: false,
      useGlobalAgentModel: true,
      useGlobalCodexReasoningEffort: false,
      useGlobalPollingIntervalMs: true,
      useGlobalMaxConcurrentAgents: true,
      agentProvider: "codex",
      codexReasoningEffort: "high",
      source: {
        kind: "existingPath",
        path: process.cwd()
      }
    });

    const configFile = await readFile(path.join(root, "orchestrai.config.ts"), "utf8");
    const workflowFile = await readFile(created.workflowPath, "utf8");
    const compiledEnv = await readFile(path.join(created.workflowDirectory, ".env.local"), "utf8");
    const promptFile = await readFile(path.join(root, "prompts", "storybook.md"), "utf8");

    expect(configFile).toContain('"kind": "existingPath"');
    expect(configFile).toContain(`"path": "${process.cwd()}"`);
    expect(workflowFile).toContain("provider: codex");
    expect(workflowFile).toContain("reasoning_effort: high");
    expect(workflowFile).toContain('git clone --local "${PROJECT_SOURCE}" repo');
    expect(compiledEnv).toContain(`PROJECT_SOURCE="${process.cwd()}"`);
    expect(compiledEnv).toContain('LINEAR_API_KEY="lin_test"');
    expect(promptFile).toContain("You are working on a Linear ticket");
    expect(created.agentModel).toBe("gpt-5.2-codex");
    expect(created.enabled).toBe(false);
  });

  it("recompiles projects when shared provider defaults change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-backed-projects-global-"));
    tempRoots.push(root);

    const service = new ConfigBackedProjectsService(root, {}, new ProviderRegistry(builtinProviderPlugins));
    await service.initConfig();
    const created = await service.createProject({
      displayName: "Shared Provider",
      projectSlug: "shared-provider",
      githubRepository: "example/shared-provider",
      linearApiKey: "lin_test",
      useGlobalLinearApiKey: false,
      useGlobalXaiApiKey: true,
      useGlobalGithubToken: true,
      useGlobalAgentProvider: true,
      useGlobalAgentModel: true,
      useGlobalCodexReasoningEffort: true,
      useGlobalPollingIntervalMs: true,
      useGlobalMaxConcurrentAgents: true
    });

    expect(await readFile(created.workflowPath, "utf8")).toContain("provider: codex");

    const updatedGlobal = await service.updateGlobalConfig({
      agentProvider: "claude",
      agentModel: "sonnet"
    });
    const updatedWorkflow = await readFile(created.workflowPath, "utf8");

    expect(updatedGlobal.defaults.agentProvider).toBe("claude");
    expect(updatedGlobal.defaults.agentModel).toBe("sonnet");
    expect(updatedWorkflow).toContain("provider: claude");
    expect(updatedWorkflow).toContain("model: sonnet");
    expect(updatedWorkflow).toContain("claude:");
  });

  it("removes compiled artifacts when a project is deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "config-backed-projects-remove-"));
    tempRoots.push(root);

    const service = new ConfigBackedProjectsService(root, {}, new ProviderRegistry(builtinProviderPlugins));
    await service.initConfig();
    const created = await service.createProject({
      projectSlug: "cleanup-me",
      githubRepository: "example/cleanup-me",
      linearApiKey: "lin_test",
      useGlobalLinearApiKey: false,
      useGlobalXaiApiKey: true,
      useGlobalGithubToken: true,
      useGlobalAgentProvider: true,
      useGlobalAgentModel: true,
      useGlobalCodexReasoningEffort: true,
      useGlobalPollingIntervalMs: true,
      useGlobalMaxConcurrentAgents: true
    });

    await service.removeProject(created.id);

    await expect(stat(created.workflowDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
