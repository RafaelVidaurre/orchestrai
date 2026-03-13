import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { buildServiceConfig } from "../src/config";
import type { WorkflowDefinition } from "../src/domain";
import { loadEnvFiles, loadWorkflowEnv } from "../src/env";

describe("buildServiceConfig", () => {
  it("resolves env-backed secrets and normalizes state overrides", () => {
    const workflow: WorkflowDefinition = {
      config: {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "$PROJECT_SLUG",
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
      PROJECT_SLUG: "project-alpha",
      WORKSPACE_ROOT: "/tmp/project-alpha-workspaces"
    });

    expect(config.tracker.apiKey).toBe("linear-token");
    expect(config.tracker.projectSlug).toBe("project-alpha");
    expect(config.project.enabled).toBe(true);
    expect(config.workspace.root).toBe(path.resolve("/tmp/project-alpha-workspaces"));
    expect(config.agent.maxConcurrentAgentsByState).toEqual({
      todo: 1,
      "in progress": 2
    });
  });

  it("loads .env and lets .env.local override it without overriding shell env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-env-test-"));
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

  it("builds an isolated workflow env without mutating the base env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-env-copy-"));
    await writeFile(path.join(root, ".env"), "PROJECT_SLUG=from-workflow\n");

    const baseEnv: NodeJS.ProcessEnv = {
      LINEAR_API_KEY: "from-shell"
    };

    const scopedEnv = await loadWorkflowEnv(root, baseEnv);

    expect(baseEnv.PROJECT_SLUG).toBeUndefined();
    expect(scopedEnv.LINEAR_API_KEY).toBe("from-shell");
    expect(scopedEnv.PROJECT_SLUG).toBe("from-workflow");
  });

  it("auto-includes workflow-managed active states when the prompt expects them", () => {
    const workflow: WorkflowDefinition = {
      config: {
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "project-alpha",
          active_states: ["Todo", "In Progress"]
        }
      },
      prompt_template: "Move the ticket to Human Review when complete. When approved, move it to Merging. If changes are requested, move it to Rework."
    };

    const config = buildServiceConfig("/tmp/workflow.md", workflow, {});
    expect(config.tracker.activeStates).toContain("Human Review");
    expect(config.tracker.activeStates).toContain("Merging");
    expect(config.tracker.activeStates).toContain("Rework");
  });

  it("uses the Symphony-style codex defaults when omitted", () => {
    const workflow: WorkflowDefinition = {
      config: {
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "project-alpha"
        }
      },
      prompt_template: "hello"
    };

    const config = buildServiceConfig("/tmp/workflow.md", workflow, {});
    expect(config.codex.command).toBe(
      "codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=xhigh app-server"
    );
    expect(config.codex.approvalPolicy).toBe("never");
    expect(config.codex.threadSandbox).toBe("workspace-write");
    expect(config.codex.turnSandboxPolicy).toEqual({
      type: "workspaceWrite",
      networkAccess: true
    });
  });

  it("respects project.enabled when explicitly disabled", () => {
    const workflow: WorkflowDefinition = {
      config: {
        project: {
          enabled: false
        },
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "project-alpha"
        }
      },
      prompt_template: "hello"
    };

    const config = buildServiceConfig("/tmp/workflow.md", workflow, {});
    expect(config.project.enabled).toBe(false);
  });
});
