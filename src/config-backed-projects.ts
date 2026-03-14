import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseEnv } from "dotenv";
import YAML from "yaml";

import type {
  GlobalConfigInput,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput
} from "./domain";
import { normalizeCodexReasoningEffort } from "./domain";
import { ServiceError } from "./errors";
import { readFatalProjectError } from "./fatal-runtime-errors";
import { applyGlobalEnv } from "./global-config";
import {
  defaultOrchestraiConfig,
  defineConfig,
  orchestraiConfigPath,
  readOrchestraiConfig,
  type OrchestraiConfig,
  type OrchestraiProjectConfig,
  type ProjectSource,
  writeOrchestraiConfig
} from "./orchestrai-config";
import { type ProviderRegistry } from "./provider-registry";

const DEFAULT_PROJECT_PROMPT = `You are working on a Linear ticket \`{{ issue.identifier }}\`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Operating rules:
1. This is an unattended orchestration session. Do not ask a human to perform follow-up actions if you still have a path forward.
2. Before making changes, inspect the repository for \`AGENTS.md\` and follow it. Treat \`README.md\` as human-facing background unless \`AGENTS.md\` tells you otherwise.
3. Only stop early for a true blocker: missing required auth, missing permissions, missing secrets, missing external access, or repeated tracker/API HTTP 4xx failures that you cannot resolve from inside this repo.
4. Do not loop on the same failing action. If a tracker or external API call fails repeatedly with the same blocker, stop retrying that exact action, summarize the blocker in your work, and move the issue to the best available blocked or handoff state if you have the access to do so.
5. Final output must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy.`;

const DEFAULT_GITIGNORE_ENTRIES = [".orchestrai/", ".env.local", "node_modules/"] as const;

export interface ConfigBackedProjectCreateInput extends ProjectSetupInput {
  id?: string | null;
  source?:
    | {
        kind: "clone";
        repository: string;
      }
    | {
        kind: "existingPath";
        path: string;
      }
    | null;
}

export class ConfigBackedProjectsService {
  constructor(
    private readonly projectsRoot: string,
    private readonly env: NodeJS.ProcessEnv,
    private registry: ProviderRegistry
  ) {}

  setRegistry(registry: ProviderRegistry): void {
    this.registry = registry;
  }

  async initConfig(): Promise<void> {
    const configPath = orchestraiConfigPath(this.projectsRoot);
    const existing = await readFile(configPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    await this.ensureDirectories();
    if (!existing) {
      await writeOrchestraiConfig(this.projectsRoot, defineConfig(defaultOrchestraiConfig()));
    }
  }

  async readGlobalConfig(): Promise<GlobalConfigRecord> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const rootEnv = await this.readRootEnv();
    const defaultCodexOptions = config.defaults.providerOptions.codex ?? {};
    return {
      projectsRoot: path.resolve(this.projectsRoot),
      envFilePath: path.join(path.resolve(this.projectsRoot), ".env.local"),
      defaults: {
        pollingIntervalMs: config.defaults.pollingIntervalMs,
        maxConcurrentAgents: config.defaults.maxConcurrentAgents,
        agentProvider: config.defaults.agentProvider,
        agentModel: config.defaults.agentModel,
        codexReasoningEffort: normalizeCodexReasoningEffort(defaultCodexOptions.reasoningEffort) ?? "medium"
      },
      hasLinearApiKey: typeof rootEnv.LINEAR_API_KEY === "string" && rootEnv.LINEAR_API_KEY.length > 0,
      hasXaiApiKey: typeof rootEnv.XAI_API_KEY === "string" && rootEnv.XAI_API_KEY.length > 0,
      hasGithubToken: typeof rootEnv.GITHUB_TOKEN === "string" && rootEnv.GITHUB_TOKEN.length > 0
    };
  }

  async updateGlobalConfig(input: GlobalConfigInput): Promise<GlobalConfigRecord> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const next = {
      ...config,
      defaults: {
        ...config.defaults,
        pollingIntervalMs:
          typeof input.pollingIntervalMs === "number" && Number.isFinite(input.pollingIntervalMs) && input.pollingIntervalMs > 0
            ? Math.trunc(input.pollingIntervalMs)
            : config.defaults.pollingIntervalMs,
        maxConcurrentAgents:
          typeof input.maxConcurrentAgents === "number" && Number.isFinite(input.maxConcurrentAgents) && input.maxConcurrentAgents > 0
            ? Math.trunc(input.maxConcurrentAgents)
            : config.defaults.maxConcurrentAgents,
        agentProvider:
          typeof input.agentProvider === "string" && input.agentProvider.trim().length > 0
            ? input.agentProvider.trim()
            : config.defaults.agentProvider,
        agentModel: typeof input.agentModel === "string" ? input.agentModel.trim() : config.defaults.agentModel,
        providerOptions: {
          ...config.defaults.providerOptions,
          codex: {
            ...(config.defaults.providerOptions.codex ?? {}),
            reasoningEffort:
              normalizeCodexReasoningEffort(input.codexReasoningEffort) ??
              normalizeCodexReasoningEffort(config.defaults.providerOptions.codex?.reasoningEffort) ??
              "medium"
          }
        }
      }
    } satisfies OrchestraiConfig;

    await writeOrchestraiConfig(this.projectsRoot, next);

    const currentEnv = await this.readRootEnv();
    const nextEnv = {
      ...currentEnv
    };
    if (input.clearLinearApiKey) {
      delete nextEnv.LINEAR_API_KEY;
    } else if (typeof input.linearApiKey === "string" && input.linearApiKey.trim().length > 0) {
      nextEnv.LINEAR_API_KEY = input.linearApiKey.trim();
    }
    if (input.clearXaiApiKey) {
      delete nextEnv.XAI_API_KEY;
    } else if (typeof input.xaiApiKey === "string" && input.xaiApiKey.trim().length > 0) {
      nextEnv.XAI_API_KEY = input.xaiApiKey.trim();
    }
    if (input.clearGithubToken) {
      delete nextEnv.GITHUB_TOKEN;
    } else if (typeof input.githubToken === "string" && input.githubToken.trim().length > 0) {
      nextEnv.GITHUB_TOKEN = input.githubToken.trim();
    }

    await this.writeRootEnv(nextEnv);
    applyGlobalEnv(this.env, nextEnv);
    await this.syncRuntimeArtifacts();
    return this.readGlobalConfig();
  }

  async listProjects(): Promise<ManagedProjectRecord[]> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const global = await this.readGlobalConfig();
    const records = await Promise.all(config.projects.map((project) => this.toManagedProjectRecord(project, global)));
    return records.sort((left, right) => visibleProjectName(left).localeCompare(visibleProjectName(right)));
  }

  async createProject(input: ConfigBackedProjectCreateInput): Promise<ProjectSetupResult> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const global = await this.readGlobalConfig();
    const id = sanitizeProjectId(input.id ?? input.projectSlug);
    if (config.projects.some((project) => project.id === id)) {
      throw new ServiceError("invalid_project_setup", `Project ${id} already exists`);
    }

    const project = this.buildProjectConfig(id, input, global);
    config.projects.push(project);
    await writeOrchestraiConfig(this.projectsRoot, config);
    await this.ensurePromptFile(project);
    await this.writeProjectSecrets(project.id, input);
    await this.syncRuntimeArtifacts();
    return this.toManagedProjectRecord(project, await this.readGlobalConfig());
  }

  async updateProject(input: ProjectUpdateInput): Promise<ManagedProjectRecord> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const global = await this.readGlobalConfig();
    const project = config.projects.find((candidate) => candidate.id === input.id);
    if (!project) {
      throw new ServiceError("invalid_project_setup", `Project ${input.id} does not exist`);
    }

    project.displayName = typeof input.displayName === "string" ? input.displayName : project.displayName;
    project.projectSlug = input.projectSlug.trim();
    project.githubRepository = input.githubRepository.trim() || project.githubRepository;
    project.pollingIntervalMs =
      input.useGlobalPollingIntervalMs === true
        ? null
        : typeof input.pollingIntervalMs === "number" && Number.isFinite(input.pollingIntervalMs) && input.pollingIntervalMs > 0
          ? Math.trunc(input.pollingIntervalMs)
          : project.pollingIntervalMs ?? null;
    project.agent = {
      ...project.agent,
      provider:
        input.useGlobalAgentProvider === true
          ? null
          : typeof input.agentProvider === "string" && input.agentProvider.trim().length > 0
            ? input.agentProvider.trim()
            : project.agent?.provider ?? null,
      model:
        input.useGlobalAgentModel === true
          ? null
          : typeof input.agentModel === "string"
            ? input.agentModel.trim() || null
            : project.agent?.model ?? null,
      maxConcurrentAgents:
        input.useGlobalMaxConcurrentAgents === true
          ? null
          : typeof input.maxConcurrentAgents === "number" && Number.isFinite(input.maxConcurrentAgents) && input.maxConcurrentAgents > 0
            ? Math.trunc(input.maxConcurrentAgents)
            : project.agent?.maxConcurrentAgents ?? null,
      options: {
        ...(project.agent?.options ?? {}),
        ...(input.useGlobalCodexReasoningEffort === true
          ? {}
          : normalizeCodexReasoningEffort(input.codexReasoningEffort)
            ? { reasoningEffort: normalizeCodexReasoningEffort(input.codexReasoningEffort) }
            : {})
      }
    };
    project.secrets = {
      useGlobalLinearApiKey: input.useGlobalLinearApiKey !== false ? true : false,
      useGlobalXaiApiKey: input.useGlobalXaiApiKey !== false ? true : false,
      useGlobalGithubToken: input.useGlobalGithubToken !== false ? true : false
    };

    if (input.useGlobalCodexReasoningEffort === true && project.agent?.options) {
      delete project.agent.options.reasoningEffort;
    }

    await writeOrchestraiConfig(this.projectsRoot, config);
    await this.writeProjectSecrets(project.id, input);
    await this.syncRuntimeArtifacts();
    return this.toManagedProjectRecord(project, await this.readGlobalConfig());
  }

  async setProjectEnabled(input: ProjectRuntimeControlInput, enabled: boolean): Promise<ManagedProjectRecord> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const global = await this.readGlobalConfig();
    const project = config.projects.find((candidate) => candidate.id === input.id);
    if (!project) {
      throw new ServiceError("invalid_project_setup", `Project ${input.id} does not exist`);
    }
    project.enabled = enabled;
    await writeOrchestraiConfig(this.projectsRoot, config);
    await this.syncRuntimeArtifacts();
    return this.toManagedProjectRecord(project, global);
  }

  async removeProject(id: string): Promise<void> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    const remaining = config.projects.filter((project) => project.id !== id);
    if (remaining.length === config.projects.length) {
      return;
    }
    config.projects = remaining;
    await writeOrchestraiConfig(this.projectsRoot, config);
    await rm(this.compiledProjectDir(id), { recursive: true, force: true });
    await rm(this.projectSecretsFile(id), { force: true });
  }

  async compiledWorkflowPaths(): Promise<string[]> {
    const config = await readOrchestraiConfig(this.projectsRoot);
    return config.projects.map((project) => path.join(this.compiledProjectDir(project.id), "WORKFLOW.md"));
  }

  async syncRuntimeArtifacts(): Promise<string[]> {
    await this.ensureDirectories();
    const config = await readOrchestraiConfig(this.projectsRoot);
    const global = await this.readGlobalConfig();
    const activeProjectIds = new Set(config.projects.map((project) => project.id));

    for (const project of config.projects) {
      await this.ensurePromptFile(project);
      await this.writeCompiledProject(project, global, config.defaults.providerOptions);
    }

    const compiledRoot = this.compiledProjectsRoot();
    const entries = await readDirSafe(compiledRoot);
    await Promise.all(
      entries
        .filter((entry) => !activeProjectIds.has(entry))
        .map((entry) => rm(path.join(compiledRoot, entry), { recursive: true, force: true }))
    );

    return config.projects.map((project) => path.join(this.compiledProjectDir(project.id), "WORKFLOW.md"));
  }

  private buildProjectConfig(
    id: string,
    input: ConfigBackedProjectCreateInput,
    global: GlobalConfigRecord
  ): OrchestraiProjectConfig {
    return {
      id,
      displayName: typeof input.displayName === "string" ? input.displayName : null,
      enabled: false,
      projectSlug: input.projectSlug.trim(),
      githubRepository: input.githubRepository.trim() || null,
      source:
        input.source ??
        ({
          kind: "clone",
          repository: input.githubRepository.trim()
        } satisfies ProjectSource),
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql"
      },
      workspace: {
        root: ".orchestrai/workspaces"
      },
      hooks: {
        timeoutMs: 60000
      },
      agent: {
        provider: input.useGlobalAgentProvider === true ? null : input.agentProvider ?? null,
        model: input.useGlobalAgentModel === true ? null : input.agentModel ?? null,
        options:
          input.useGlobalCodexReasoningEffort === true
            ? {}
            : normalizeCodexReasoningEffort(input.codexReasoningEffort)
              ? { reasoningEffort: normalizeCodexReasoningEffort(input.codexReasoningEffort) }
              : {},
        maxConcurrentAgents:
          input.useGlobalMaxConcurrentAgents === true
            ? null
            : typeof input.maxConcurrentAgents === "number" && input.maxConcurrentAgents > 0
              ? Math.trunc(input.maxConcurrentAgents)
              : null,
        maxTurns: 20,
        maxRetryBackoffMs: 300000
      },
      pollingIntervalMs:
        input.useGlobalPollingIntervalMs === true
          ? null
          : typeof input.pollingIntervalMs === "number" && input.pollingIntervalMs > 0
            ? Math.trunc(input.pollingIntervalMs)
            : null,
      promptPath: path.join("prompts", `${id}.md`),
      secrets: {
        useGlobalLinearApiKey: input.useGlobalLinearApiKey !== false ? true : false,
        useGlobalXaiApiKey: input.useGlobalXaiApiKey !== false ? true : false,
        useGlobalGithubToken: input.useGlobalGithubToken !== false ? true : false
      },
      telemetry: {
        monthlyBudgetUsd: null
      }
    };
  }

  private async toManagedProjectRecord(
    project: OrchestraiProjectConfig,
    global: GlobalConfigRecord
  ): Promise<ManagedProjectRecord> {
    const plugin = this.registry.get(project.agent?.provider ?? global.defaults.agentProvider);
    const projectEnv = await this.readProjectEnv(project.id);
    const codexEffort =
      normalizeCodexReasoningEffort(project.agent?.options?.reasoningEffort) ??
      normalizeCodexReasoningEffort(global.defaults.codexReasoningEffort) ??
      "medium";
    const workflowPath = path.join(this.compiledProjectDir(project.id), "WORKFLOW.md");

    return {
      id: project.id,
      displayName: project.displayName,
      enabled: project.enabled,
      runtimeRunning: false,
      fatalError: await readFatalProjectError(workflowPath),
      projectSlug: project.projectSlug,
      githubRepository: project.githubRepository,
      agentProvider: project.agent?.provider ?? global.defaults.agentProvider,
      agentModel: resolveProjectModel(project, global, plugin.defaultModel),
      codexReasoningEffort: codexEffort,
      usesGlobalAgentProvider: !project.agent?.provider,
      usesGlobalAgentModel: !project.agent?.model,
      usesGlobalCodexReasoningEffort: !normalizeCodexReasoningEffort(project.agent?.options?.reasoningEffort),
      workflowDirectory: this.compiledProjectDir(project.id),
      workflowPath,
      envFilePath: this.projectSecretsFile(project.id),
      pollingIntervalMs: project.pollingIntervalMs ?? global.defaults.pollingIntervalMs,
      maxConcurrentAgents: project.agent?.maxConcurrentAgents ?? global.defaults.maxConcurrentAgents,
      hasLinearApiKey:
        project.secrets.useGlobalLinearApiKey
          ? global.hasLinearApiKey
          : typeof projectEnv.LINEAR_API_KEY === "string" && projectEnv.LINEAR_API_KEY.length > 0,
      hasXaiApiKey:
        project.secrets.useGlobalXaiApiKey
          ? global.hasXaiApiKey
          : typeof projectEnv.XAI_API_KEY === "string" && projectEnv.XAI_API_KEY.length > 0,
      hasGithubToken:
        project.secrets.useGlobalGithubToken
          ? global.hasGithubToken
          : typeof projectEnv.GITHUB_TOKEN === "string" && projectEnv.GITHUB_TOKEN.length > 0,
      usesGlobalLinearApiKey: project.secrets.useGlobalLinearApiKey,
      usesGlobalXaiApiKey: project.secrets.useGlobalXaiApiKey,
      usesGlobalGithubToken: project.secrets.useGlobalGithubToken,
      usesGlobalPollingIntervalMs: project.pollingIntervalMs === null || project.pollingIntervalMs === undefined,
      usesGlobalMaxConcurrentAgents: project.agent?.maxConcurrentAgents === null || project.agent?.maxConcurrentAgents === undefined
    };
  }

  private async writeCompiledProject(
    project: OrchestraiProjectConfig,
    global: GlobalConfigRecord,
    globalProviderOptions: Record<string, Record<string, unknown>>
  ): Promise<void> {
    const plugin = this.registry.get(project.agent?.provider ?? global.defaults.agentProvider);
    const promptPath = path.resolve(this.projectsRoot, project.promptPath);
    const prompt = await readFile(promptPath, "utf8").catch(() => DEFAULT_PROJECT_PROMPT);
    const runtimeDir = this.compiledProjectDir(project.id);
    await mkdir(runtimeDir, { recursive: true });

    const provider = project.agent?.provider ?? global.defaults.agentProvider;
    const model = resolveProjectModel(project, global, plugin.defaultModel);
    const providerSections = plugin.compileWorkflowSections?.({
      projectId: project.id,
      model,
      options: {
        ...(globalProviderOptions[provider] ?? {}),
        ...(project.agent?.options ?? {})
      },
      envFileReferences: {
        linearApiKey: "$LINEAR_API_KEY",
        xaiApiKey: "$XAI_API_KEY",
        githubToken: "$GITHUB_TOKEN",
        projectSlug: "$PROJECT_SLUG",
        githubRepository: "$GITHUB_REPOSITORY",
        projectSource: "$PROJECT_SOURCE"
      }
    });

    const frontMatter = stripUndefinedDeep({
      tracker: {
        kind: "linear",
        endpoint: project.tracker?.endpoint ?? "https://api.linear.app/graphql",
        api_key: "$LINEAR_API_KEY",
        project_slug: "$PROJECT_SLUG",
        active_states: ["Todo", "In Progress", "Human Review", "Merging", "Rework"],
        terminal_states: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]
      },
      workspace: {
        root: project.workspace?.root ?? ".orchestrai/workspaces"
      },
      hooks: {
        timeout_ms: project.hooks?.timeoutMs ?? 60000,
        after_create: project.hooks?.afterCreate ?? buildAfterCreateScript(project),
        before_run: project.hooks?.beforeRun ?? undefined,
        after_run: project.hooks?.afterRun ?? undefined,
        before_remove: project.hooks?.beforeRemove ?? undefined
      },
      project: {
        enabled: project.enabled,
        name: project.displayName ?? undefined
      },
      polling:
        project.pollingIntervalMs !== null && project.pollingIntervalMs !== undefined
          ? {
              interval_ms: project.pollingIntervalMs
            }
          : undefined,
      agent: {
        max_concurrent_agents:
          project.agent?.maxConcurrentAgents !== null && project.agent?.maxConcurrentAgents !== undefined
            ? project.agent.maxConcurrentAgents
            : undefined,
        max_turns: project.agent?.maxTurns ?? 20,
        max_retry_backoff_ms: project.agent?.maxRetryBackoffMs ?? 300000
      },
      runtime: {
        provider,
        model
      },
      server: {
        port: -1
      },
      ...(providerSections ?? {})
    });

    await writeFile(
      path.join(runtimeDir, "WORKFLOW.md"),
      `---\n${YAML.stringify(frontMatter)}---\n${prompt.trim()}\n`,
      "utf8"
    );

    const projectEnv = await this.readProjectEnv(project.id);
    const compiledEnv = stripUndefined({
      PROJECT_SLUG: project.projectSlug,
      GITHUB_REPOSITORY: project.githubRepository ?? "",
      PROJECT_SOURCE: project.source.kind === "clone" ? project.source.repository : path.resolve(this.projectsRoot, project.source.path),
      ...(project.secrets.useGlobalLinearApiKey ? {} : { LINEAR_API_KEY: projectEnv.LINEAR_API_KEY }),
      ...(project.secrets.useGlobalXaiApiKey ? {} : { XAI_API_KEY: projectEnv.XAI_API_KEY }),
      ...(project.secrets.useGlobalGithubToken ? {} : { GITHUB_TOKEN: projectEnv.GITHUB_TOKEN })
    });
    await writeLooseEnvFile(path.join(runtimeDir, ".env.local"), compiledEnv);
  }

  private async ensurePromptFile(project: OrchestraiProjectConfig): Promise<void> {
    const promptPath = path.resolve(this.projectsRoot, project.promptPath);
    await mkdir(path.dirname(promptPath), { recursive: true });
    const existing = await readFile(promptPath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!existing) {
      await writeFile(promptPath, `${DEFAULT_PROJECT_PROMPT}\n`, "utf8");
    }
  }

  private async writeProjectSecrets(projectId: string, input: Pick<ProjectSetupInput, "linearApiKey" | "xaiApiKey" | "githubToken">): Promise<void> {
    const current = await this.readProjectEnv(projectId);
    const next = {
      ...current
    };
    if (typeof input.linearApiKey === "string" && input.linearApiKey.trim().length > 0) {
      next.LINEAR_API_KEY = input.linearApiKey.trim();
    }
    if (typeof input.xaiApiKey === "string" && input.xaiApiKey.trim().length > 0) {
      next.XAI_API_KEY = input.xaiApiKey.trim();
    }
    if (typeof input.githubToken === "string" && input.githubToken.trim().length > 0) {
      next.GITHUB_TOKEN = input.githubToken.trim();
    }
    await writeLooseEnvFile(this.projectSecretsFile(projectId), next);
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(path.join(this.projectsRoot, ".orchestrai"), { recursive: true });
    await mkdir(path.join(this.projectsRoot, ".orchestrai", "projects"), { recursive: true });
    await mkdir(this.compiledProjectsRoot(), { recursive: true });
    await mkdir(path.join(this.projectsRoot, "prompts"), { recursive: true });
    await this.ensureGitignoreEntries();
  }

  private projectSecretsFile(projectId: string): string {
    return path.join(this.projectsRoot, ".orchestrai", "projects", `${projectId}.env`);
  }

  private compiledProjectsRoot(): string {
    return path.join(this.projectsRoot, ".orchestrai", "runtime", "projects");
  }

  private compiledProjectDir(projectId: string): string {
    return path.join(this.compiledProjectsRoot(), projectId);
  }

  private async readRootEnv(): Promise<Record<string, string>> {
    return readLooseEnvFile(path.join(this.projectsRoot, ".env.local"));
  }

  private async writeRootEnv(values: Record<string, string | undefined>): Promise<void> {
    await writeLooseEnvFile(path.join(this.projectsRoot, ".env.local"), values);
  }

  private async readProjectEnv(projectId: string): Promise<Record<string, string>> {
    return readLooseEnvFile(this.projectSecretsFile(projectId));
  }

  private async ensureGitignoreEntries(): Promise<void> {
    const gitignorePath = path.join(this.projectsRoot, ".gitignore");
    const existing = await readFile(gitignorePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    });

    const lines = existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const missing = DEFAULT_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
    if (missing.length === 0) {
      return;
    }

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const next = `${existing}${prefix}${missing.join("\n")}\n`;
    await writeFile(gitignorePath, next, "utf8");
  }
}

export function resolveProjectModel(
  project: OrchestraiProjectConfig,
  global: GlobalConfigRecord,
  providerDefaultModel: string
): string {
  if (typeof project.agent?.model === "string" && project.agent.model.trim().length > 0) {
    return project.agent.model.trim();
  }
  if (global.defaults.agentModel.trim().length > 0) {
    return global.defaults.agentModel.trim();
  }
  return providerDefaultModel;
}

function buildAfterCreateScript(project: OrchestraiProjectConfig): string {
  if (project.source.kind === "existingPath") {
    return [
      "set -euo pipefail",
      'if [[ -d "${PROJECT_SOURCE}/.git" ]]; then',
      '  git clone --local "${PROJECT_SOURCE}" repo',
      "else",
      "  mkdir -p repo",
      '  cp -R "${PROJECT_SOURCE}"/. repo',
      "fi"
    ].join("\n");
  }

  return [
    "set -euo pipefail",
    'if [[ "${PROJECT_SOURCE}" == git@* || "${PROJECT_SOURCE}" == *"://"* || "${PROJECT_SOURCE}" == /* ]]; then',
    '  git clone "${PROJECT_SOURCE}" repo',
    'elif [[ -n "${GITHUB_TOKEN:-}" ]]; then',
    '  git clone "https://${GITHUB_TOKEN}@github.com/${PROJECT_SOURCE}.git" repo',
    "else",
    '  git clone "git@github.com:${PROJECT_SOURCE}.git" repo || git clone "https://github.com/${PROJECT_SOURCE}.git" repo',
    "fi"
  ].join("\n");
}

async function readLooseEnvFile(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return parseEnv(content);
}

async function writeLooseEnvFile(filePath: string, values: Record<string, string | undefined>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");
  await writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

async function readDirSafe(filePath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
}

function stripUndefined<T extends Record<string, string | undefined>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "string" && entry.length > 0)) as T;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)])
  );
}

function sanitizeProjectId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!normalized) {
    throw new ServiceError("invalid_project_setup", "Project id cannot be empty");
  }
  return normalized;
}

function visibleProjectName(project: Pick<ManagedProjectRecord, "displayName" | "projectSlug">): string {
  return project.displayName ?? project.projectSlug;
}
