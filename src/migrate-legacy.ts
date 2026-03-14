import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readGlobalConfig as readLegacyGlobalConfig } from "./global-config";
import {
  defaultOrchestraiConfig,
  readOrchestraiConfig,
  type OrchestraiConfig,
  type OrchestraiProjectConfig,
  writeOrchestraiConfig
} from "./orchestrai-config";
import { readProjectSetup } from "./project-setup";
import { parseWorkflowFile, resolveWorkflowContext } from "./workflow";

export interface LegacyMigrationReport {
  projectsRoot: string;
  migratedProjects: Array<{
    id: string;
    workflowPath: string;
    promptPath: string;
  }>;
}

export async function migrateLegacyWorkflows(
  legacyTarget: string | undefined,
  projectsRoot: string,
  env: NodeJS.ProcessEnv
): Promise<LegacyMigrationReport> {
  const workflowContext = await resolveWorkflowContext(legacyTarget, { allowEmpty: false });
  const nextConfig = await readOrchestraiConfig(projectsRoot).catch(() => defaultOrchestraiConfig());
  const legacyGlobal = await readLegacyGlobalConfig(workflowContext.projectsRoot, env);

  nextConfig.defaults = {
    pollingIntervalMs: legacyGlobal.defaults.pollingIntervalMs,
    maxConcurrentAgents: legacyGlobal.defaults.maxConcurrentAgents,
    agentProvider: legacyGlobal.defaults.agentProvider,
    agentModel: legacyGlobal.defaults.agentModel,
    providerOptions: {
      codex: {
        reasoningEffort: legacyGlobal.defaults.codexReasoningEffort
      }
    }
  };

  const migratedProjects: LegacyMigrationReport["migratedProjects"] = [];
  const existingIds = new Set(nextConfig.projects.map((project) => project.id));

  for (const workflowPath of workflowContext.workflowPaths) {
    const setup = await readProjectSetup(workflowPath, env, workflowContext.projectsRoot);
    const definition = parseWorkflowFile(await readFile(workflowPath, "utf8"));
    const root = definition.config as Record<string, unknown>;
    const hooks = asObject(root.hooks);
    const tracker = asObject(root.tracker);
    const projectId = uniqueProjectId(setup.projectSlug, existingIds);
    const promptPath = path.join("prompts", `${projectId}.md`);

    const project: OrchestraiProjectConfig = {
      id: projectId,
      displayName: setup.displayName,
      enabled: setup.enabled,
      projectSlug: setup.projectSlug,
      githubRepository: setup.githubRepository,
      source: {
        kind: "clone",
        repository: setup.githubRepository ?? setup.projectSlug
      },
      tracker: {
        kind: "linear",
        endpoint: typeof tracker.endpoint === "string" && tracker.endpoint.trim().length > 0 ? tracker.endpoint.trim() : undefined
      },
      workspace: {
        root: ".orchestrai/workspaces"
      },
      hooks: {
        afterCreate: typeof hooks.after_create === "string" ? hooks.after_create : null,
        beforeRun: typeof hooks.before_run === "string" ? hooks.before_run : null,
        afterRun: typeof hooks.after_run === "string" ? hooks.after_run : null,
        beforeRemove: typeof hooks.before_remove === "string" ? hooks.before_remove : null,
        timeoutMs: typeof hooks.timeout_ms === "number" ? hooks.timeout_ms : 60000
      },
      agent: {
        provider: setup.usesGlobalAgentProvider ? null : setup.agentProvider,
        model: setup.usesGlobalAgentModel ? null : setup.agentModel,
        options:
          setup.agentProvider === "codex" && !setup.usesGlobalCodexReasoningEffort
            ? {
                reasoningEffort: setup.codexReasoningEffort
              }
            : {},
        maxConcurrentAgents: setup.usesGlobalMaxConcurrentAgents ? null : setup.maxConcurrentAgents,
        maxTurns: 20,
        maxRetryBackoffMs: 300000
      },
      pollingIntervalMs: setup.usesGlobalPollingIntervalMs ? null : setup.pollingIntervalMs,
      promptPath,
      secrets: {
        useGlobalLinearApiKey: setup.usesGlobalLinearApiKey,
        useGlobalXaiApiKey: setup.usesGlobalXaiApiKey,
        useGlobalGithubToken: setup.usesGlobalGithubToken
      },
      telemetry: {
        monthlyBudgetUsd: null
      }
    };

    nextConfig.projects.push(project);
    await mkdir(path.join(projectsRoot, "prompts"), { recursive: true });
    await writeFile(path.join(projectsRoot, promptPath), `${definition.prompt_template.trim()}\n`, "utf8");
    const legacyEnv = await readFile(setup.envFilePath, "utf8").catch(() => "");
    await mkdir(path.join(projectsRoot, ".orchestrai", "projects"), { recursive: true });
    await writeFile(path.join(projectsRoot, ".orchestrai", "projects", `${projectId}.env`), legacyEnv, "utf8");
    migratedProjects.push({
      id: projectId,
      workflowPath,
      promptPath: path.join(projectsRoot, promptPath)
    });
  }

  await writeOrchestraiConfig(projectsRoot, normalizeConfigForWrite(nextConfig));
  return {
    projectsRoot: path.resolve(projectsRoot),
    migratedProjects
  };
}

function uniqueProjectId(seed: string, existingIds: Set<string>): string {
  const base = seed.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "project";
  let next = base;
  let counter = 2;
  while (existingIds.has(next)) {
    next = `${base}-${counter}`;
    counter += 1;
  }
  existingIds.add(next);
  return next;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeConfigForWrite(config: OrchestraiConfig): OrchestraiConfig {
  return {
    ...config,
    version: 2,
    projects: [...config.projects]
  };
}
