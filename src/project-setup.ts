import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";
import YAML from "yaml";

import type {
  DashboardSetupContext,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  WorkflowDefinition
} from "./domain";
import { ServiceError } from "./errors";
import { loadWorkflowEnv } from "./env";
import { readGlobalConfig } from "./global-config";
import { parseWorkflowFile } from "./workflow";

const DEFAULT_PROJECT_PROMPT = `You are working on a Linear issue.

Issue context:

- Identifier: \`{{ issue.identifier }}\`
- Title: \`{{ issue.title }}\`
- State: \`{{ issue.state }}\`
- Priority: \`{{ issue.priority }}\`
- Labels: \`{{ issue.labels | join: ", " }}\`
- Branch: \`{{ issue.branch_name }}\`
- URL: \`{{ issue.url }}\`

{% if issue.description %}
Issue description:

{{ issue.description }}
{% endif %}

{% if issue.blocked_by.size > 0 %}
Blockers:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }} (state: {{ blocker.state }})
{% endfor %}
{% endif %}

{% if attempt %}
This is retry or continuation attempt \`{{ attempt }}\`. Inspect the workspace, continue from existing progress, and avoid repeating completed work.
{% else %}
This is the first attempt for this issue.
{% endif %}

Execution rules:

1. Operate only inside the issue workspace.
2. Use the repository checked out by the workflow hooks. Do not touch any unrelated path.
3. Make the smallest correct change that moves the issue to the next valid handoff state.
4. Use the configured Linear MCP for issue reads and writes. If Linear MCP is unavailable or unauthenticated, stop immediately and surface that blocker.
5. Validate your work before handing off when the repo tooling allows it.`;

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

type ProjectSecrets = {
  LINEAR_API_KEY?: string;
  PROJECT_SLUG?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_TOKEN?: string;
};

export async function createProjectSetup(
  projectsRoot: string,
  input: ProjectSetupInput,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<ProjectSetupResult> {
  const globalConfig = await readGlobalConfig(projectsRoot, baseEnv);
  const normalized = normalizeProjectSetupInput(input, globalConfig);
  const workflowDirectory = path.resolve(projectsRoot, sanitizeProjectDirectory(normalized.projectSlug));
  const workflowPath = path.join(workflowDirectory, "WORKFLOW.md");
  const envFilePath = path.join(workflowDirectory, ".env.local");

  await ensureProjectDirectoryAvailable(workflowDirectory);
  await mkdir(workflowDirectory, { recursive: true });

  await writeFile(workflowPath, renderWorkflowMarkdown(normalized), "utf8");
  await writeProjectSecrets(envFilePath, {
    PROJECT_SLUG: normalized.projectSlug,
    GITHUB_REPOSITORY: normalized.githubRepository,
    ...(normalized.useGlobalLinearApiKey ? {} : { LINEAR_API_KEY: normalized.linearApiKey ?? undefined }),
    ...(normalized.useGlobalGithubToken ? {} : { GITHUB_TOKEN: normalized.githubToken ?? undefined })
  });

  const record = await readProjectSetup(workflowPath, baseEnv, projectsRoot);
  return {
    ...record,
    githubRepository: normalized.githubRepository
  };
}

export async function listProjectSetups(
  workflowPaths: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string
): Promise<ManagedProjectRecord[]> {
  const projects = await Promise.all(
    workflowPaths.map((workflowPath) => readProjectSetup(workflowPath, baseEnv, projectsRoot))
  );
  return projects.sort((left, right) => visibleProjectName(left).localeCompare(visibleProjectName(right)));
}

export async function readProjectSetup(
  workflowPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, "utf8");
  const workflow = parseWorkflowFile(workflowContent);
  const root = asObject(workflow.config);
  const project = asObject(root.project);
  const polling = asObject(root.polling);
  const agent = asObject(root.agent);
  const envFilePath = path.join(path.dirname(absoluteWorkflowPath), ".env.local");
  const localEnv = await readProjectSecrets(envFilePath);
  const resolvedProjectsRoot = resolveProjectsRoot(absoluteWorkflowPath, projectsRoot);
  const globalConfig = await readGlobalConfig(resolvedProjectsRoot, baseEnv);
  const effectiveEnv = await loadWorkflowEnv(path.dirname(absoluteWorkflowPath), baseEnv, undefined, resolvedProjectsRoot);
  const trackerConfig = asObject(root.tracker);
  const hooksConfig = asObject(root.hooks);
  const projectSlug = typeof localEnv.PROJECT_SLUG === "string"
    ? localEnv.PROJECT_SLUG
    : typeof effectiveEnv.PROJECT_SLUG === "string"
      ? effectiveEnv.PROJECT_SLUG
    : typeof trackerConfig.project_slug === "string"
      ? trackerConfig.project_slug
      : "";
  const githubRepository = typeof localEnv.GITHUB_REPOSITORY === "string"
    ? localEnv.GITHUB_REPOSITORY
    : typeof effectiveEnv.GITHUB_REPOSITORY === "string"
      ? effectiveEnv.GITHUB_REPOSITORY
    : typeof hooksConfig.github_repository === "string"
      ? hooksConfig.github_repository
      : null;
  const usesGlobalLinearApiKey = !(typeof localEnv.LINEAR_API_KEY === "string" && localEnv.LINEAR_API_KEY.length > 0);
  const usesGlobalGithubToken = !(typeof localEnv.GITHUB_TOKEN === "string" && localEnv.GITHUB_TOKEN.length > 0);
  const usesGlobalPollingIntervalMs = !hasOwnValue(polling.interval_ms);
  const usesGlobalMaxConcurrentAgents = !hasOwnValue(agent.max_concurrent_agents);

  return {
    id: absoluteWorkflowPath,
    displayName: typeof project.name === "string" && project.name.trim().length > 0 ? project.name.trim() : null,
    enabled: coerceBoolean(project.enabled, true),
    runtimeRunning: false,
    projectSlug,
    githubRepository,
    workflowDirectory: path.dirname(absoluteWorkflowPath),
    workflowPath: absoluteWorkflowPath,
    envFilePath,
    pollingIntervalMs: usesGlobalPollingIntervalMs
      ? globalConfig.defaults.pollingIntervalMs
      : coercePositiveInteger(polling.interval_ms, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: usesGlobalMaxConcurrentAgents
      ? globalConfig.defaults.maxConcurrentAgents
      : coercePositiveInteger(agent.max_concurrent_agents, globalConfig.defaults.maxConcurrentAgents),
    hasLinearApiKey: usesGlobalLinearApiKey
      ? globalConfig.hasLinearApiKey
      : typeof localEnv.LINEAR_API_KEY === "string" && localEnv.LINEAR_API_KEY.length > 0,
    hasGithubToken: usesGlobalGithubToken
      ? globalConfig.hasGithubToken
      : typeof localEnv.GITHUB_TOKEN === "string" && localEnv.GITHUB_TOKEN.length > 0,
    usesGlobalLinearApiKey,
    usesGlobalGithubToken,
    usesGlobalPollingIntervalMs,
    usesGlobalMaxConcurrentAgents
  };
}

export async function updateProjectSetup(
  workflowPath: string,
  input: ProjectUpdateInput,
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, "utf8");
  const definition = parseWorkflowFile(workflowContent);
  const root = asObject(definition.config);
  const resolvedProjectsRoot = resolveProjectsRoot(absoluteWorkflowPath, projectsRoot);
  const globalConfig = await readGlobalConfig(resolvedProjectsRoot, baseEnv);
  const normalized = normalizeProjectUpdateInput(input, globalConfig);
  const currentRecord = await readProjectSetup(absoluteWorkflowPath, baseEnv, resolvedProjectsRoot);
  const currentSecrets = await readProjectSecrets(currentRecord.envFilePath);

  setNestedString(root, ["tracker", "kind"], "linear");
  setNestedString(root, ["tracker", "api_key"], "$LINEAR_API_KEY");
  setNestedString(root, ["tracker", "project_slug"], "$PROJECT_SLUG");
  setNestedString(root, ["workspace", "root"], ".orchestrai/workspaces");
  setNestedString(root, ["codex", "command"], "codex app-server");
  setNestedString(root, ["codex", "approval_policy"], "never");
  setNestedString(root, ["codex", "thread_sandbox"], "workspace-write");
  setNestedString(root, ["hooks", "timeout_ms"], "60000");
  setNestedString(root, ["server", "port"], "-1");

  const projectConfig = ensureObject(root, "project");
  projectConfig.enabled = currentRecord.enabled;
  if (normalized.displayName) {
    projectConfig.name = normalized.displayName;
  } else {
    delete projectConfig.name;
  }
  if (normalized.useGlobalPollingIntervalMs) {
    deleteNestedValue(root, ["polling", "interval_ms"]);
  } else {
    setNestedNumber(root, ["polling", "interval_ms"], normalized.pollingIntervalMs ?? globalConfig.defaults.pollingIntervalMs);
  }
  if (normalized.useGlobalMaxConcurrentAgents) {
    deleteNestedValue(root, ["agent", "max_concurrent_agents"]);
  } else {
    setNestedNumber(
      root,
      ["agent", "max_concurrent_agents"],
      normalized.maxConcurrentAgents ?? globalConfig.defaults.maxConcurrentAgents
    );
  }

  await writeWorkflowDefinition(absoluteWorkflowPath, {
    config: root,
    prompt_template: definition.prompt_template.trim().length > 0 ? definition.prompt_template : DEFAULT_PROJECT_PROMPT
  });

  const nextSecrets: ProjectSecrets = {
    ...currentSecrets,
    PROJECT_SLUG: normalized.projectSlug,
    GITHUB_REPOSITORY: normalized.githubRepository
  };

  if (normalized.useGlobalLinearApiKey) {
    delete nextSecrets.LINEAR_API_KEY;
  } else if (normalized.linearApiKey) {
    nextSecrets.LINEAR_API_KEY = normalized.linearApiKey;
  }
  if (normalized.useGlobalGithubToken) {
    delete nextSecrets.GITHUB_TOKEN;
  } else if (normalized.githubToken) {
    nextSecrets.GITHUB_TOKEN = normalized.githubToken;
  }

  await writeProjectSecrets(currentRecord.envFilePath, nextSecrets);

  const desiredDirectory = path.resolve(path.dirname(currentRecord.workflowDirectory), sanitizeProjectDirectory(normalized.projectSlug));
  let finalWorkflowPath = absoluteWorkflowPath;
  if (desiredDirectory !== currentRecord.workflowDirectory) {
    await ensureProjectDirectoryAvailable(desiredDirectory);
    await rename(currentRecord.workflowDirectory, desiredDirectory);
    finalWorkflowPath = path.join(desiredDirectory, "WORKFLOW.md");
  }

  return readProjectSetup(finalWorkflowPath, baseEnv, resolvedProjectsRoot);
}

export async function setProjectEnabled(
  workflowPath: string,
  input: ProjectRuntimeControlInput & { enabled: boolean },
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, "utf8");
  const definition = parseWorkflowFile(workflowContent);
  const root = asObject(definition.config);
  const normalized = normalizeProjectRuntimeControlInput(input);
  const projectConfig = ensureObject(root, "project");
  projectConfig.enabled = normalized.enabled;

  await writeWorkflowDefinition(absoluteWorkflowPath, {
    config: root,
    prompt_template: definition.prompt_template.trim().length > 0 ? definition.prompt_template : DEFAULT_PROJECT_PROMPT
  });

  return readProjectSetup(absoluteWorkflowPath, baseEnv, projectsRoot);
}

export async function removeProjectSetup(workflowPath: string): Promise<void> {
  const record = await readProjectSetup(workflowPath);
  await rm(record.workflowDirectory, { recursive: true, force: true });
}

export function createDashboardSetupContext(projectsRoot: string): DashboardSetupContext {
  return {
    projectsRoot: path.resolve(projectsRoot),
    trackerKind: "linear",
    repositoryProvider: "github",
    globalConfig: {
      projectsRoot: path.resolve(projectsRoot),
      envFilePath: path.join(path.resolve(projectsRoot), ".env.local"),
      defaults: {
        pollingIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS
      },
      hasLinearApiKey: false,
      hasGithubToken: false
    }
  };
}

export function visibleProjectName(project: Pick<ManagedProjectRecord, "displayName" | "projectSlug">): string {
  return project.displayName ?? project.projectSlug;
}

function renderWorkflowMarkdown(input: {
  displayName: string | null;
  pollingIntervalMs: number | null;
  maxConcurrentAgents: number | null;
  useGlobalPollingIntervalMs: boolean;
  useGlobalMaxConcurrentAgents: boolean;
}): string {
  const frontMatter: Record<string, unknown> = {
    tracker: {
      kind: "linear",
      api_key: "$LINEAR_API_KEY",
      project_slug: "$PROJECT_SLUG",
      active_states: ["Todo", "In Progress", "Human Review"],
      terminal_states: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]
    },
    workspace: {
      root: ".orchestrai/workspaces"
    },
    hooks: {
      timeout_ms: 60000,
      after_create: [
        "set -euo pipefail",
        'if [[ -n "${GITHUB_TOKEN:-}" ]]; then',
        '  git clone "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" repo',
        "else",
        '  git clone "git@github.com:${GITHUB_REPOSITORY}.git" repo || git clone "https://github.com/${GITHUB_REPOSITORY}.git" repo',
        "fi"
      ].join("\n")
    },
    agent: {
      max_turns: 20,
      max_retry_backoff_ms: 300000
    },
    codex: {
      command: "codex app-server",
      approval_policy: "never",
      thread_sandbox: "workspace-write"
    },
    server: {
      port: -1
    }
  };

  frontMatter.project = {
    enabled: true,
    ...(input.displayName ? { name: input.displayName } : {})
  };
  if (!input.useGlobalPollingIntervalMs && input.pollingIntervalMs) {
    frontMatter.polling = {
      interval_ms: input.pollingIntervalMs
    };
  }
  if (!input.useGlobalMaxConcurrentAgents && input.maxConcurrentAgents) {
    const agentConfig = asObject(frontMatter.agent);
    agentConfig.max_concurrent_agents = input.maxConcurrentAgents;
  }

  return `---\n${YAML.stringify(frontMatter)}---\n${DEFAULT_PROJECT_PROMPT}\n`;
}

async function ensureProjectDirectoryAvailable(workflowDirectory: string): Promise<void> {
  const existing = await stat(workflowDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (existing) {
    throw new ServiceError("workflow_exists", "A project workflow with this slug already exists", {
      workflow_directory: workflowDirectory
    });
  }
}

async function readProjectSecrets(filePath: string): Promise<ProjectSecrets> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return parse(content);
}

async function writeProjectSecrets(filePath: string, secrets: ProjectSecrets): Promise<void> {
  const lines = Object.entries(secrets)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeWorkflowDefinition(filePath: string, definition: WorkflowDefinition): Promise<void> {
  await writeFile(filePath, `---\n${YAML.stringify(definition.config)}---\n${definition.prompt_template.trim()}\n`, "utf8");
}

function normalizeProjectSetupInput(
  input: ProjectSetupInput,
  globalConfig: Awaited<ReturnType<typeof readGlobalConfig>>
) {
  const useGlobalLinearApiKey =
    input.useGlobalLinearApiKey === true ||
    (!normalizeOptionalValue(input.linearApiKey) && globalConfig.hasLinearApiKey);
  const useGlobalGithubToken = input.useGlobalGithubToken === true || !normalizeOptionalValue(input.githubToken);
  const useGlobalPollingIntervalMs = input.useGlobalPollingIntervalMs !== false;
  const useGlobalMaxConcurrentAgents = input.useGlobalMaxConcurrentAgents !== false;
  const linearApiKey = normalizeOptionalValue(input.linearApiKey);

  if (!useGlobalLinearApiKey && !linearApiKey) {
    throw new ServiceError("invalid_project_setup", "linearApiKey is required when no global Linear API key is configured");
  }

  return {
    displayName: normalizeOptionalValue(input.displayName),
    projectSlug: normalizeRequiredValue(input.projectSlug, "projectSlug"),
    linearApiKey,
    githubRepository: normalizeGitHubRepository(input.githubRepository),
    githubToken: normalizeOptionalValue(input.githubToken),
    pollingIntervalMs: useGlobalPollingIntervalMs ? null : coercePositiveInteger(input.pollingIntervalMs, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: useGlobalMaxConcurrentAgents
      ? null
      : coercePositiveInteger(input.maxConcurrentAgents, globalConfig.defaults.maxConcurrentAgents),
    useGlobalLinearApiKey,
    useGlobalGithubToken,
    useGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents
  };
}

function normalizeProjectUpdateInput(
  input: ProjectUpdateInput,
  globalConfig: Awaited<ReturnType<typeof readGlobalConfig>>
) {
  const useGlobalLinearApiKey = input.useGlobalLinearApiKey === true;
  const useGlobalGithubToken = input.useGlobalGithubToken === true;
  const useGlobalPollingIntervalMs = input.useGlobalPollingIntervalMs === true;
  const useGlobalMaxConcurrentAgents = input.useGlobalMaxConcurrentAgents === true;

  return {
    id: normalizeRequiredValue(input.id, "id"),
    displayName: normalizeOptionalValue(input.displayName),
    projectSlug: normalizeRequiredValue(input.projectSlug, "projectSlug"),
    githubRepository: normalizeGitHubRepository(input.githubRepository),
    linearApiKey: normalizeOptionalValue(input.linearApiKey),
    githubToken: normalizeOptionalValue(input.githubToken),
    pollingIntervalMs: useGlobalPollingIntervalMs
      ? null
      : coercePositiveInteger(input.pollingIntervalMs, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: useGlobalMaxConcurrentAgents
      ? null
      : coercePositiveInteger(input.maxConcurrentAgents, globalConfig.defaults.maxConcurrentAgents),
    useGlobalLinearApiKey,
    useGlobalGithubToken,
    useGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents
  };
}

function normalizeProjectRuntimeControlInput(input: ProjectRuntimeControlInput & { enabled: boolean }) {
  return {
    id: normalizeRequiredValue(input.id, "id"),
    enabled: Boolean(input.enabled)
  };
}

function resolveProjectsRoot(workflowPath: string, projectsRoot?: string): string {
  if (projectsRoot) {
    return path.resolve(projectsRoot);
  }

  return path.resolve(path.dirname(path.dirname(workflowPath)));
}

function normalizeGitHubRepository(value: string): string {
  const trimmed = normalizeRequiredValue(value, "githubRepository");
  const sshMatch = /^git@github\.com:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch?.groups?.repo) {
    return sshMatch.groups.repo;
  }

  const httpsMatch = /^https:\/\/github\.com\/(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch?.groups?.repo) {
    return httpsMatch.groups.repo;
  }

  const shorthandMatch = /^(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthandMatch?.groups?.repo) {
    return shorthandMatch.groups.repo;
  }

  throw new ServiceError("invalid_github_repository", "GitHub repository must be owner/name, https URL, or git@ URL", {
    github_repository: value
  });
}

function sanitizeProjectDirectory(projectSlug: string): string {
  return projectSlug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function normalizeRequiredValue(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ServiceError("invalid_project_setup", `${field} is required`);
  }

  return normalized;
}

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  return fallback;
}

function hasOwnValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function coercePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function ensureObject(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObject(container[key]);
  container[key] = existing;
  return existing;
}

function setNestedString(root: Record<string, unknown>, pathSegments: string[], value: string): void {
  const target = ensureNestedObject(root, pathSegments.slice(0, -1));
  target[pathSegments[pathSegments.length - 1]] = value;
}

function setNestedNumber(root: Record<string, unknown>, pathSegments: string[], value: number): void {
  const target = ensureNestedObject(root, pathSegments.slice(0, -1));
  target[pathSegments[pathSegments.length - 1]] = value;
}

function deleteNestedValue(root: Record<string, unknown>, pathSegments: string[]): void {
  if (pathSegments.length === 0) {
    return;
  }

  const parent = ensureNestedObject(root, pathSegments.slice(0, -1));
  delete parent[pathSegments[pathSegments.length - 1]];
}

function ensureNestedObject(root: Record<string, unknown>, pathSegments: string[]): Record<string, unknown> {
  let current = root;
  for (const segment of pathSegments) {
    current = ensureObject(current, segment);
  }
  return current;
}
