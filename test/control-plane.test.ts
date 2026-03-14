import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneService } from "../src/control-plane";
import { ServiceError } from "../src/errors";
import { Logger } from "../src/logger";
import type { UsageMetricsStore } from "../src/usage-metrics";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("control plane", () => {
  it("initializes built-in providers and manages config-backed projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "control-plane-"));
    tempRoots.push(root);

    const controlPlane = new ControlPlaneService(root, new Logger({}, { writeToStreams: false }), {});
    await controlPlane.initialize();

    const providers = controlPlane.listProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["claude", "codex", "grok"]);

    const catalog = await controlPlane.listProviderModels({
      provider: "codex",
      useStoredKey: false
    });
    expect(catalog.models.map((model) => model.value)).toContain("gpt-5.2-codex");

    const created = await controlPlane.createProject({
      displayName: "Control Plane",
      projectSlug: "control-plane",
      githubRepository: "example/control-plane",
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

    const projects = await controlPlane.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(created.id);
    expect(projects[0].enabled).toBe(false);
    expect(controlPlane.state().configuredWorkflowCount).toBe(1);

    await controlPlane.stop();
  });

  it("supports an initialized workspace with no configured projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "control-plane-empty-"));
    tempRoots.push(root);

    const controlPlane = new ControlPlaneService(root, new Logger({}, { writeToStreams: false }), {});
    await controlPlane.initialize();

    expect(await controlPlane.listProjects()).toEqual([]);
    expect(controlPlane.state().configuredWorkflowCount).toBe(0);

    const setup = await controlPlane.dashboardSetupContext();
    expect(setup.projectsRoot).toBe(path.resolve(root));
    expect(setup.globalConfig.projectsRoot).toBe(path.resolve(root));

    await controlPlane.stop();
  });

  it("refuses to start a project that is missing required runtime auth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "control-plane-preflight-"));
    tempRoots.push(root);

    const controlPlane = new ControlPlaneService(root, new Logger({}, { writeToStreams: false }), {});
    await controlPlane.initialize();

    const created = await controlPlane.createProject({
      displayName: "Missing Auth",
      projectSlug: "missing-auth",
      githubRepository: "example/missing-auth",
      useGlobalLinearApiKey: true,
      useGlobalXaiApiKey: true,
      useGlobalGithubToken: true,
      useGlobalAgentProvider: false,
      useGlobalAgentModel: true,
      useGlobalCodexReasoningEffort: true,
      useGlobalPollingIntervalMs: true,
      useGlobalMaxConcurrentAgents: true,
      agentProvider: "grok"
    });

    await expect(controlPlane.startProject({ id: created.id })).rejects.toMatchObject({
      name: "ServiceError",
      code: "project_start_validation_failed"
    } satisfies Partial<ServiceError>);

    await controlPlane.stop();
  });

  it("clears persisted usage history for a selected project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "control-plane-usage-clear-"));
    tempRoots.push(root);

    const controlPlane = new ControlPlaneService(root, new Logger({}, { writeToStreams: false }), {});
    await controlPlane.initialize();

    const created = await controlPlane.createProject({
      displayName: "Usage Clear",
      projectSlug: "usage-clear",
      githubRepository: "example/usage-clear",
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

    const usageStore = (controlPlane as unknown as { usageMetricsStore: UsageMetricsStore }).usageMetricsStore;
    await usageStore.recordUsage({
      workflowPath: created.workflowPath,
      projectSlug: created.projectSlug,
      displayName: created.displayName,
      provider: "codex",
      model: created.agentModel,
      observedAt: new Date().toISOString(),
      usage: {
        input_tokens: 2_000,
        output_tokens: 1_000,
        total_tokens: 3_000
      }
    });

    const before = await controlPlane.usageMetrics();
    expect(before.projects[0]?.lifetime.total_tokens).toBe(3_000);

    const after = await controlPlane.clearUsageHistory({ id: created.id });
    expect(after.projects).toEqual([]);

    await controlPlane.stop();
  });
});
