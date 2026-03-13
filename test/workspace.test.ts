import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceConfig } from "../src/domain";
import { Logger } from "../src/logger";
import { WorkspaceManager } from "../src/workspace";

const pathsToRemove: string[] = [];

afterEach(async () => {
  for (const root of pathsToRemove.splice(0, pathsToRemove.length)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("WorkspaceManager", () => {
  it("creates a workspace and runs after_create only once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
    pathsToRemove.push(root);
    const manager = new WorkspaceManager(new Logger({}, "error"));
    const config = configFixture(root, {
      afterCreate: "echo created >> ../after-create.log"
    });

    const first = await manager.ensureWorkspace(config, "ST-1");
    const second = await manager.ensureWorkspace(config, "ST-1");

    expect(first.createdNow).toBe(true);
    expect(second.createdNow).toBe(false);

    const logContent = await readFile(path.join(root, "after-create.log"), "utf8");
    expect(logContent.trim().split("\n")).toHaveLength(1);
  });
});

function configFixture(root: string, hookOverrides?: { afterCreate?: string | null }): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "stori",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"]
    },
    polling: {
      intervalMs: 30000
    },
    workspace: {
      root
    },
    hooks: {
      afterCreate: hookOverrides?.afterCreate ?? null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 2000
    },
    agent: {
      maxConcurrentAgents: 10,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
      maxTurns: 20
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000
    }
  };
}
