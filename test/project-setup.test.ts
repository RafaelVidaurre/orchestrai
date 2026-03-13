import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProjectSetup,
  readProjectSetup,
  removeProjectSetup,
  setProjectEnabled,
  updateProjectSetup
} from "../src/project-setup";

describe("project setup", () => {
  it("creates a workflow and env file for a GitHub repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "project-setup-"));
    try {
      const result = await createProjectSetup(root, {
        displayName: "Game Client",
        projectSlug: "mmorpg-8915add3c6c3",
        linearApiKey: "lin_api_123",
        githubRepository: "https://github.com/example/game-client.git",
        githubToken: "ghp_secret",
        pollingIntervalMs: 15000,
        maxConcurrentAgents: 4,
        useGlobalPollingIntervalMs: false,
        useGlobalMaxConcurrentAgents: false
      });

      const workflow = await readFile(result.workflowPath, "utf8");
      const envFile = await readFile(result.envFilePath, "utf8");
      const record = await readProjectSetup(result.workflowPath);

      expect(result.githubRepository).toBe("example/game-client");
      expect(result.displayName).toBe("Game Client");
      expect(result.enabled).toBe(true);
      expect(workflow).toContain("name: Game Client");
      expect(workflow).toContain("enabled: true");
      expect(workflow).toContain("interval_ms: 15000");
      expect(workflow).toContain("max_concurrent_agents: 4");
      expect(workflow).toContain("- Merging");
      expect(workflow).toContain("- Rework");
      expect(workflow).toContain("model_reasoning_effort=xhigh");
      expect(workflow).toContain("shell_environment_policy.inherit=all");
      expect(workflow).toContain("thread_sandbox: danger-full-access");
      expect(workflow).toContain("turn_sandbox_policy:");
      expect(workflow).toContain("type: dangerFullAccess");
      expect(workflow).toContain("## Step 0: Determine current ticket state and route");
      expect(workflow).toContain("## Codex Workpad");
      expect(envFile).toContain('LINEAR_API_KEY="lin_api_123"');
      expect(envFile).toContain('PROJECT_SLUG="mmorpg-8915add3c6c3"');
      expect(envFile).toContain('GITHUB_REPOSITORY="example/game-client"');
      expect(envFile).toContain('GITHUB_TOKEN="ghp_secret"');
      expect(record.displayName).toBe("Game Client");
      expect(record.enabled).toBe(true);
      expect(record.pollingIntervalMs).toBe(15000);
      expect(record.maxConcurrentAgents).toBe(4);
      expect(record.hasLinearApiKey).toBe(true);
      expect(record.hasGithubToken).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates project settings and can clear the GitHub token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "project-update-"));
    try {
      const created = await createProjectSetup(root, {
        displayName: "Game Client",
        projectSlug: "mmorpg-8915add3c6c3",
        linearApiKey: "lin_api_123",
        githubRepository: "example/game-client",
        githubToken: "ghp_secret"
      });

      const updated = await updateProjectSetup(created.workflowPath, {
        id: created.id,
        displayName: "Backend",
        projectSlug: "backend-123",
        githubRepository: "example/backend",
        linearApiKey: null,
        githubToken: null,
        pollingIntervalMs: 10000,
        maxConcurrentAgents: 2,
        useGlobalGithubToken: true
      });

      const envFile = await readFile(updated.envFilePath, "utf8");
      expect(updated.displayName).toBe("Backend");
      expect(updated.projectSlug).toBe("backend-123");
      expect(updated.githubRepository).toBe("example/backend");
      expect(updated.pollingIntervalMs).toBe(10000);
      expect(updated.maxConcurrentAgents).toBe(2);
      expect(updated.hasGithubToken).toBe(false);
      expect(updated.workflowDirectory.endsWith("backend-123")).toBe(true);
      expect(envFile).toContain('PROJECT_SLUG="backend-123"');
      expect(envFile).toContain('GITHUB_REPOSITORY="example/backend"');
      expect(envFile).not.toContain("GITHUB_TOKEN=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes the project directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "project-remove-"));
    try {
      const created = await createProjectSetup(root, {
        projectSlug: "cleanup-test",
        linearApiKey: "lin_api_123",
        githubRepository: "example/game-client"
      });

      await removeProjectSetup(created.workflowPath);

      await expect(stat(created.workflowDirectory)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can persist a stopped project state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "project-stop-"));
    try {
      const created = await createProjectSetup(root, {
        projectSlug: "pause-me",
        linearApiKey: "lin_api_123",
        githubRepository: "example/game-client"
      });

      const stopped = await setProjectEnabled(created.workflowPath, {
        id: created.id,
        enabled: false
      });

      const workflow = await readFile(stopped.workflowPath, "utf8");
      expect(stopped.enabled).toBe(false);
      expect(workflow).toContain("enabled: false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits shared defaults and secrets from the projects root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "project-global-defaults-"));
    try {
      await writeFile(
        path.join(root, ".env.local"),
        'LINEAR_API_KEY="lin_global"\nORCHESTRAI_DEFAULT_POLLING_INTERVAL_MS="12000"\nORCHESTRAI_DEFAULT_MAX_CONCURRENT_AGENTS="7"\n',
        "utf8"
      );

      const created = await createProjectSetup(root, {
        displayName: "Shared Defaults",
        projectSlug: "shared-defaults",
        githubRepository: "example/shared-defaults"
      });

      const workflow = await readFile(created.workflowPath, "utf8");
      const envFile = await readFile(created.envFilePath, "utf8");
      const record = await readProjectSetup(created.workflowPath, process.env, root);

      expect(workflow).not.toContain("interval_ms:");
      expect(workflow).not.toContain("max_concurrent_agents:");
      expect(envFile).not.toContain("LINEAR_API_KEY=");
      expect(record.pollingIntervalMs).toBe(12000);
      expect(record.maxConcurrentAgents).toBe(7);
      expect(record.usesGlobalLinearApiKey).toBe(true);
      expect(record.usesGlobalPollingIntervalMs).toBe(true);
      expect(record.usesGlobalMaxConcurrentAgents).toBe(true);
      expect(record.hasLinearApiKey).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
