import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UsageMetricsStore } from "../src/usage-metrics";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("usage metrics store", () => {
  it("records per-project usage, model mix, and budget status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-metrics-"));
    tempRoots.push(root);
    const store = new UsageMetricsStore(root);
    const workflowPath = path.join(root, "alpha", "WORKFLOW.md");
    const observedAt = new Date().toISOString();

    await store.updateBudget({
      id: workflowPath,
      monthlyBudgetUsd: 1
    });
    await store.recordUsage({
      workflowPath,
      projectSlug: "alpha",
      displayName: "Alpha",
      provider: "codex",
      model: "gpt-5.2-codex",
      observedAt,
      usage: {
        input_tokens: 100_000,
        output_tokens: 50_000,
        total_tokens: 150_000
      }
    });
    await store.recordUsage({
      workflowPath,
      projectSlug: "alpha",
      displayName: "Alpha",
      provider: "claude",
      model: "default",
      observedAt,
      usage: {
        input_tokens: 1_000,
        output_tokens: 500,
        total_tokens: 1_500
      }
    });

    const snapshot = await store.snapshot([workflowPath]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      workflow_path: workflowPath,
      project_slug: "alpha",
      display_name: "Alpha",
      lifetime: {
        total_tokens: 151_500,
        cost_usd: 0.45,
        unpriced_total_tokens: 1_500
      },
      current_month: {
        total_tokens: 151_500,
        cost_usd: 0.45,
        unpriced_total_tokens: 1_500
      },
      budget: {
        monthly_budget_usd: 1,
        current_month_cost_usd: 0.45,
        status: "partial"
      }
    });
    expect(snapshot.projects[0].models.map((model) => model.model)).toEqual(["gpt-5.2-codex", "default"]);
  });

  it("persists metrics to disk and supports removing a project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-metrics-persist-"));
    tempRoots.push(root);
    const workflowPath = path.join(root, "beta", "WORKFLOW.md");
    const observedAt = new Date().toISOString();

    const firstStore = new UsageMetricsStore(root);
    await firstStore.recordUsage({
      workflowPath,
      projectSlug: "beta",
      displayName: null,
      provider: "grok",
      model: "grok-4-1-fast-reasoning",
      observedAt,
      usage: {
        input_tokens: 5_000,
        output_tokens: 1_000,
        total_tokens: 6_000,
        cost_usd: 0.02
      }
    });
    await firstStore.flush();

    const secondStore = new UsageMetricsStore(root);
    const persisted = await secondStore.snapshot([workflowPath]);
    expect(persisted.projects[0]?.current_month.cost_usd).toBe(0.02);
    expect(persisted.projects[0]?.latest_model).toBe("grok-4-1-fast-reasoning");

    await secondStore.removeProject(workflowPath);
    await secondStore.flush();

    const thirdStore = new UsageMetricsStore(root);
    const empty = await thirdStore.snapshot([workflowPath]);
    expect(empty.projects).toHaveLength(0);
  });

  it("clears persisted usage history while preserving project budgets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-metrics-clear-"));
    tempRoots.push(root);
    const workflowPath = path.join(root, "gamma", "WORKFLOW.md");
    const observedAt = new Date().toISOString();

    const store = new UsageMetricsStore(root);
    await store.updateBudget({
      id: workflowPath,
      monthlyBudgetUsd: 12
    });
    await store.recordUsage({
      workflowPath,
      projectSlug: "gamma",
      displayName: "Gamma",
      provider: "grok",
      model: "grok-code-fast-1",
      observedAt,
      usage: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        total_tokens: 12_000,
        cost_usd: 0.03
      }
    });

    await store.clearHistory(workflowPath);

    const snapshot = await store.snapshot([workflowPath]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]).toMatchObject({
      workflow_path: workflowPath,
      lifetime: {
        total_tokens: 0,
        cost_usd: 0
      },
      current_month: {
        total_tokens: 0,
        cost_usd: 0
      },
      models: [],
      budget: {
        monthly_budget_usd: 12,
        current_month_cost_usd: 0,
        status: "within_budget"
      }
    });
  });

  it("clears all tracked usage history across projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-metrics-clear-all-"));
    tempRoots.push(root);
    const alphaWorkflowPath = path.join(root, "alpha", "WORKFLOW.md");
    const betaWorkflowPath = path.join(root, "beta", "WORKFLOW.md");
    const observedAt = new Date().toISOString();

    const store = new UsageMetricsStore(root);
    await store.recordUsage({
      workflowPath: alphaWorkflowPath,
      projectSlug: "alpha",
      displayName: "Alpha",
      provider: "codex",
      model: "gpt-5.2-codex",
      observedAt,
      usage: {
        input_tokens: 2_000,
        output_tokens: 1_000,
        total_tokens: 3_000
      }
    });
    await store.recordUsage({
      workflowPath: betaWorkflowPath,
      projectSlug: "beta",
      displayName: "Beta",
      provider: "grok",
      model: "grok-code-fast-1",
      observedAt,
      usage: {
        input_tokens: 500,
        output_tokens: 500,
        total_tokens: 1_000,
        cost_usd: 0.01
      }
    });

    await store.clearHistory();

    const snapshot = await store.snapshot([alphaWorkflowPath, betaWorkflowPath]);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.totals.current_month.total_tokens).toBe(0);
    expect(snapshot.totals.lifetime.cost_usd).toBe(0);
  });
});
