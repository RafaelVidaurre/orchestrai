import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentProvider,
  AgentUsageSnapshot,
  ModelUsageMetrics,
  ProjectUsageBudgetInput,
  ProjectUsageMetrics,
  UsageCostSource,
  UsageMetricsSnapshot,
  UsageTotals
} from "./domain";
import { estimateUsageCost } from "./model-pricing";

type PersistedTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedTotalTokens: number;
};

type PersistedModelUsage = PersistedTotals & {
  provider: AgentProvider;
  model: string;
  costSource: UsageCostSource;
  firstSeenAt: string;
  lastSeenAt: string;
};

type PersistedMonthUsage = {
  month: string;
  totals: PersistedTotals;
  models: PersistedModelUsage[];
};

type PersistedProjectUsage = {
  workflowPath: string;
  projectSlug: string;
  displayName: string | null;
  updatedAt: string | null;
  latestProvider: AgentProvider | null;
  latestModel: string | null;
  monthlyBudgetUsd: number | null;
  lifetime: PersistedTotals;
  models: PersistedModelUsage[];
  months: PersistedMonthUsage[];
};

type PersistedUsageMetrics = {
  version: 1;
  updatedAt: string;
  projects: PersistedProjectUsage[];
};

type UsageRecordInput = {
  workflowPath: string;
  projectSlug: string;
  displayName: string | null;
  provider: AgentProvider;
  model: string;
  observedAt?: string;
  usage: AgentUsageSnapshot;
};

const STORE_VERSION = 1;
const MAX_MONTH_BUCKETS = 18;
const BUDGET_WARNING_RATIO = 0.8;

export class UsageMetricsStore {
  private readonly filePath: string;
  private readonly directoryPath: string;
  private state: PersistedUsageMetrics | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(projectsRoot: string) {
    this.directoryPath = path.join(path.resolve(projectsRoot), ".orchestrai");
    this.filePath = path.join(this.directoryPath, "usage-metrics.json");
  }

  async snapshot(filterWorkflowPaths?: Iterable<string>): Promise<UsageMetricsSnapshot> {
    await this.ensureLoaded();
    return buildSnapshot(this.state!, filterWorkflowPaths);
  }

  async recordUsage(input: UsageRecordInput): Promise<void> {
    const observedAt = normalizeTimestamp(input.observedAt);
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const state = this.state!;
      const project = ensureProject(state, input.workflowPath);
      project.projectSlug = input.projectSlug;
      project.displayName = input.displayName;
      project.updatedAt = observedAt;
      project.latestProvider = input.provider;
      project.latestModel = input.model;
      state.updatedAt = observedAt;

      const cost = estimateUsageCost(input.provider, input.model, input.usage);
      const totalsDelta = totalsFromUsage(input.usage, cost.costUsd);
      if (isZeroTotals(totalsDelta)) {
        return;
      }

      applyTotals(project.lifetime, totalsDelta);
      const lifetimeModel = ensureModel(project.models, input.provider, input.model, observedAt);
      applyTotals(lifetimeModel, totalsDelta);
      lifetimeModel.lastSeenAt = observedAt;
      lifetimeModel.costSource = chooseCostSource(lifetimeModel.costSource, cost.costSource);

      const monthKey = observedAt.slice(0, 7);
      const monthBucket = ensureMonth(project, monthKey);
      applyTotals(monthBucket.totals, totalsDelta);
      const monthModel = ensureModel(monthBucket.models, input.provider, input.model, observedAt);
      applyTotals(monthModel, totalsDelta);
      monthModel.lastSeenAt = observedAt;
      monthModel.costSource = chooseCostSource(monthModel.costSource, cost.costSource);

      trimOldMonths(project);
      this.scheduleFlush();
    });
  }

  async updateBudget(input: ProjectUsageBudgetInput): Promise<ProjectUsageMetrics> {
    const workflowPath = path.resolve(input.id);
    const normalizedBudget =
      typeof input.monthlyBudgetUsd === "number" && Number.isFinite(input.monthlyBudgetUsd) && input.monthlyBudgetUsd >= 0
        ? roundUsd(input.monthlyBudgetUsd)
        : null;

    return this.enqueue<ProjectUsageMetrics>(async () => {
      await this.ensureLoaded();
      const state = this.state!;
      const project = ensureProject(state, workflowPath);
      project.monthlyBudgetUsd = normalizedBudget;
      project.updatedAt = normalizeTimestamp(undefined);
      state.updatedAt = project.updatedAt;
      this.scheduleFlush();
      return projectToSnapshot(project, normalizeMonth(state.updatedAt));
    });
  }

  async removeProject(workflowPath: string): Promise<void> {
    const absolutePath = path.resolve(workflowPath);
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const state = this.state!;
      const nextProjects = state.projects.filter((project) => project.workflowPath !== absolutePath);
      if (nextProjects.length === state.projects.length) {
        return;
      }
      state.projects = nextProjects;
      state.updatedAt = normalizeTimestamp(undefined);
      this.scheduleFlush();
    });
  }

  async clearHistory(workflowPath?: string): Promise<void> {
    const absolutePath = workflowPath ? path.resolve(workflowPath) : null;
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const state = this.state!;
      let changed = false;

      if (absolutePath) {
        const project = state.projects.find((entry) => entry.workflowPath === absolutePath);
        if (!project) {
          return;
        }
        changed = clearProjectHistory(project);
        if (changed && project.monthlyBudgetUsd === null) {
          state.projects = state.projects.filter((entry) => entry.workflowPath !== absolutePath);
        }
      } else {
        const nextProjects: PersistedProjectUsage[] = [];
        for (const project of state.projects) {
          changed = clearProjectHistory(project) || changed;
          if (project.monthlyBudgetUsd !== null) {
            nextProjects.push(project);
          }
        }
        if (nextProjects.length !== state.projects.length) {
          changed = true;
        }
        state.projects = nextProjects;
      }

      if (!changed) {
        return;
      }

      state.updatedAt = normalizeTimestamp(undefined);
      this.scheduleFlush();
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await persistState(this.directoryPath, this.filePath, this.state!);
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) {
      return;
    }

    const raw = await readFile(this.filePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    this.state = raw ? parsePersistedState(raw) : emptyState();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.mutationQueue = this.mutationQueue
        .then(task)
        .then(resolve, reject)
        .then(
          () => undefined,
          () => undefined
        );
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, 500);
    this.flushTimer.unref();
  }
}

function emptyState(): PersistedUsageMetrics {
  return {
    version: STORE_VERSION,
    updatedAt: new Date(0).toISOString(),
    projects: []
  };
}

function parsePersistedState(raw: string): PersistedUsageMetrics {
  let parsed: PersistedUsageMetrics | null;
  try {
    parsed = JSON.parse(raw) as PersistedUsageMetrics | null;
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
    return emptyState();
  }

  return {
    version: STORE_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    projects: parsed.projects
      .map((project) => normalizeProject(project))
      .sort((left, right) => left.workflowPath.localeCompare(right.workflowPath))
  };
}

function normalizeProject(project: PersistedProjectUsage): PersistedProjectUsage {
  return {
    workflowPath: path.resolve(project.workflowPath),
    projectSlug: typeof project.projectSlug === "string" ? project.projectSlug : "",
    displayName: typeof project.displayName === "string" && project.displayName.trim().length > 0 ? project.displayName.trim() : null,
    updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : null,
    latestProvider:
      typeof project.latestProvider === "string" && project.latestProvider.trim().length > 0 ? project.latestProvider.trim() : null,
    latestModel: typeof project.latestModel === "string" && project.latestModel.trim().length > 0 ? project.latestModel.trim() : null,
    monthlyBudgetUsd:
      typeof project.monthlyBudgetUsd === "number" && Number.isFinite(project.monthlyBudgetUsd) && project.monthlyBudgetUsd >= 0
        ? roundUsd(project.monthlyBudgetUsd)
        : null,
    lifetime: normalizeTotals(project.lifetime),
    models: Array.isArray(project.models) ? project.models.map(normalizeModelUsage).sort(compareModelUsage) : [],
    months: Array.isArray(project.months)
      ? project.months
          .map((month) => ({
            month: normalizeMonth(month.month),
            totals: normalizeTotals(month.totals),
            models: Array.isArray(month.models) ? month.models.map(normalizeModelUsage).sort(compareModelUsage) : []
          }))
          .sort((left, right) => left.month.localeCompare(right.month))
      : []
  };
}

function normalizeTotals(totals: PersistedTotals | null | undefined): PersistedTotals {
  return {
    inputTokens: clampNumber(totals?.inputTokens),
    outputTokens: clampNumber(totals?.outputTokens),
    totalTokens: clampNumber(totals?.totalTokens),
    costUsd: roundUsd(clampNumber(totals?.costUsd)),
    unpricedTotalTokens: clampNumber(totals?.unpricedTotalTokens)
  };
}

function normalizeModelUsage(model: PersistedModelUsage): PersistedModelUsage {
  return {
    ...normalizeTotals(model),
    provider: model.provider,
    model: model.model,
    costSource: model.costSource,
    firstSeenAt: normalizeTimestamp(model.firstSeenAt),
    lastSeenAt: normalizeTimestamp(model.lastSeenAt)
  };
}

function ensureProject(state: PersistedUsageMetrics, workflowPath: string): PersistedProjectUsage {
  const absolutePath = path.resolve(workflowPath);
  const existing = state.projects.find((project) => project.workflowPath === absolutePath);
  if (existing) {
    return existing;
  }

  const created: PersistedProjectUsage = {
    workflowPath: absolutePath,
    projectSlug: "",
    displayName: null,
    updatedAt: null,
    latestProvider: null,
    latestModel: null,
    monthlyBudgetUsd: null,
    lifetime: emptyTotals(),
    models: [],
    months: []
  };
  state.projects.push(created);
  state.projects.sort((left, right) => left.workflowPath.localeCompare(right.workflowPath));
  return created;
}

function ensureMonth(project: PersistedProjectUsage, monthKey: string): PersistedMonthUsage {
  const normalizedMonth = normalizeMonth(monthKey);
  const existing = project.months.find((month) => month.month === normalizedMonth);
  if (existing) {
    return existing;
  }

  const created: PersistedMonthUsage = {
    month: normalizedMonth,
    totals: emptyTotals(),
    models: []
  };
  project.months.push(created);
  project.months.sort((left, right) => left.month.localeCompare(right.month));
  return created;
}

function ensureModel(models: PersistedModelUsage[], provider: AgentProvider, model: string, observedAt: string): PersistedModelUsage {
  const existing = models.find((entry) => entry.provider === provider && entry.model === model);
  if (existing) {
    return existing;
  }

  const created: PersistedModelUsage = {
    provider,
    model,
    costSource: "unknown",
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    ...emptyTotals()
  };
  models.push(created);
  models.sort(compareModelUsage);
  return created;
}

function clearProjectHistory(project: PersistedProjectUsage): boolean {
  const hadHistory =
    project.updatedAt !== null ||
    project.latestProvider !== null ||
    project.latestModel !== null ||
    !isZeroTotals(project.lifetime) ||
    project.models.length > 0 ||
    project.months.length > 0;

  project.updatedAt = null;
  project.latestProvider = null;
  project.latestModel = null;
  project.lifetime = emptyTotals();
  project.models = [];
  project.months = [];

  return hadHistory;
}

function trimOldMonths(project: PersistedProjectUsage): void {
  if (project.months.length <= MAX_MONTH_BUCKETS) {
    return;
  }

  project.months = project.months.slice(project.months.length - MAX_MONTH_BUCKETS);
}

function totalsFromUsage(usage: AgentUsageSnapshot, costUsd: number | null): PersistedTotals {
  const inputTokens = clampNumber(usage.input_tokens);
  const outputTokens = clampNumber(usage.output_tokens);
  const totalTokens = clampNumber(usage.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: roundUsd(costUsd ?? 0),
    unpricedTotalTokens: costUsd === null ? totalTokens : 0
  };
}

function applyTotals(target: PersistedTotals, delta: PersistedTotals): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.totalTokens += delta.totalTokens;
  target.costUsd = roundUsd(target.costUsd + delta.costUsd);
  target.unpricedTotalTokens += delta.unpricedTotalTokens;
}

function buildSnapshot(state: PersistedUsageMetrics, filterWorkflowPaths?: Iterable<string>): UsageMetricsSnapshot {
  const filter = filterWorkflowPaths ? new Set([...filterWorkflowPaths].map((workflowPath) => path.resolve(workflowPath))) : null;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const projects = state.projects
    .filter((project) => !filter || filter.has(project.workflowPath))
    .map((project) => projectToSnapshot(project, currentMonth))
    .sort((left, right) => left.project_slug.localeCompare(right.project_slug) || left.workflow_path.localeCompare(right.workflow_path));

  return {
    updated_at: state.updatedAt,
    current_month: currentMonth,
    projects,
    totals: {
      lifetime: projects.reduce((totals, project) => sumUsageTotals(totals, project.lifetime), emptyUsageTotals()),
      current_month: projects.reduce((totals, project) => sumUsageTotals(totals, project.current_month), emptyUsageTotals())
    }
  };
}

function projectToSnapshot(project: PersistedProjectUsage, currentMonth: string): ProjectUsageMetrics {
  const month = project.months.find((entry) => entry.month === currentMonth);
  const currentMonthTotals = month ? toUsageTotals(month.totals) : emptyUsageTotals();
  const budget = buildBudgetSummary(project.monthlyBudgetUsd, currentMonthTotals);

  return {
    workflow_path: project.workflowPath,
    project_slug: project.projectSlug,
    display_name: project.displayName,
    updated_at: project.updatedAt,
    latest_provider: project.latestProvider,
    latest_model: project.latestModel,
    lifetime: toUsageTotals(project.lifetime),
    current_month: currentMonthTotals,
    models: (month?.models ?? project.models).map(toModelUsageMetrics).sort(compareModelMetrics),
    budget
  };
}

function buildBudgetSummary(monthlyBudgetUsd: number | null, currentMonth: UsageTotals): ProjectUsageMetrics["budget"] {
  if (monthlyBudgetUsd === null) {
    return {
      monthly_budget_usd: null,
      current_month_cost_usd: currentMonth.cost_usd,
      remaining_budget_usd: null,
      status: "no_budget"
    };
  }

  const remaining = roundUsd(monthlyBudgetUsd - currentMonth.cost_usd);
  if (currentMonth.cost_usd > monthlyBudgetUsd) {
    return {
      monthly_budget_usd: monthlyBudgetUsd,
      current_month_cost_usd: currentMonth.cost_usd,
      remaining_budget_usd: remaining,
      status: "over_budget"
    };
  }

  if (currentMonth.unpriced_total_tokens > 0) {
    return {
      monthly_budget_usd: monthlyBudgetUsd,
      current_month_cost_usd: currentMonth.cost_usd,
      remaining_budget_usd: remaining,
      status: "partial"
    };
  }

  return {
    monthly_budget_usd: monthlyBudgetUsd,
    current_month_cost_usd: currentMonth.cost_usd,
    remaining_budget_usd: remaining,
    status: currentMonth.cost_usd >= monthlyBudgetUsd * BUDGET_WARNING_RATIO ? "near_budget" : "within_budget"
  };
}

function toUsageTotals(totals: PersistedTotals): UsageTotals {
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.totalTokens,
    cost_usd: totals.costUsd,
    unpriced_total_tokens: totals.unpricedTotalTokens
  };
}

function toModelUsageMetrics(model: PersistedModelUsage): ModelUsageMetrics {
  return {
    provider: model.provider,
    model: model.model,
    cost_source: model.costSource,
    first_seen_at: model.firstSeenAt,
    last_seen_at: model.lastSeenAt,
    ...toUsageTotals(model)
  };
}

function sumUsageTotals(target: UsageTotals, delta: UsageTotals): UsageTotals {
  target.input_tokens += delta.input_tokens;
  target.output_tokens += delta.output_tokens;
  target.total_tokens += delta.total_tokens;
  target.cost_usd = roundUsd(target.cost_usd + delta.cost_usd);
  target.unpriced_total_tokens += delta.unpriced_total_tokens;
  return target;
}

function emptyTotals(): PersistedTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedTotalTokens: 0
  };
}

function emptyUsageTotals(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    unpriced_total_tokens: 0
  };
}

function chooseCostSource(previous: UsageCostSource, next: UsageCostSource): UsageCostSource {
  const rank: Record<UsageCostSource, number> = {
    actual: 4,
    official: 3,
    estimated_alias: 2,
    unknown: 1
  };
  return rank[next] > rank[previous] ? next : previous;
}

function compareModelUsage(left: PersistedModelUsage, right: PersistedModelUsage): number {
  return right.lastSeenAt.localeCompare(left.lastSeenAt) || right.totalTokens - left.totalTokens || left.model.localeCompare(right.model);
}

function compareModelMetrics(left: ModelUsageMetrics, right: ModelUsageMetrics): number {
  return right.cost_usd - left.cost_usd || right.total_tokens - left.total_tokens || left.model.localeCompare(right.model);
}

function isZeroTotals(totals: PersistedTotals): boolean {
  return (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.totalTokens === 0 &&
    totals.costUsd === 0 &&
    totals.unpricedTotalTokens === 0
  );
}

function clampNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeTimestamp(value: string | undefined): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function normalizeMonth(value: string): string {
  const match = value.match(/^(\d{4}-\d{2})/);
  if (match) {
    return match[1];
  }
  return new Date().toISOString().slice(0, 7);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function persistState(directoryPath: string, filePath: string, state: PersistedUsageMetrics): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const payload = JSON.stringify(state, null, 2);
  await writeFile(tempPath, `${payload}\n`, "utf8");
  await rename(tempPath, filePath);
  await rm(tempPath, { force: true }).catch(() => undefined);
}
