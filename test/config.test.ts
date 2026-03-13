import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { buildServiceConfig } from "../src/config";
import type { WorkflowDefinition } from "../src/domain";
import { loadEnvFiles } from "../src/env";

describe("buildServiceConfig", () => {
  it("resolves env-backed secrets and normalizes state overrides", () => {
    const workflow: WorkflowDefinition = {
      config: {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "stori",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"]
        },
        workspace: {
          root: "$WORKSPACE_ROOT"
        },
        agent: {
          max_concurrent_agents_by_state: {
            Todo: 1,
            "In Progress": "2",
            Invalid: 0
          }
        }
      },
      prompt_template: "hello"
    };

    const config = buildServiceConfig("/tmp/workflow.md", workflow, {
      LINEAR_API_KEY: "linear-token",
      WORKSPACE_ROOT: "/tmp/stori-workspaces"
    });

    expect(config.tracker.apiKey).toBe("linear-token");
    expect(config.workspace.root).toBe(path.resolve("/tmp/stori-workspaces"));
    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      todo: 1,
      "in progress": 2
    });
  });

  it("loads .env and lets .env.local override it without overriding shell env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stori-env-test-"));
    await writeFile(path.join(root, ".env"), "LINEAR_API_KEY=from-dotenv\nWORKSPACE_ROOT=/tmp/from-dotenv\n");
    await writeFile(path.join(root, ".env.local"), "LINEAR_API_KEY=from-dotenv-local\nLOCAL_ONLY=present\n");

    const env: NodeJS.ProcessEnv = {
      WORKSPACE_ROOT: "/tmp/from-shell"
    };

    await loadEnvFiles(root, env);

    expect(env.WORKSPACE_ROOT).toBe("/tmp/from-shell");
    expect(env.LINEAR_API_KEY).toBe("from-dotenv-local");
    expect(env.LOCAL_ONLY).toBe("present");
  });
});
