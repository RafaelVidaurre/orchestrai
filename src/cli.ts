#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildServiceConfig } from "./config";
import { type ConfigBackedProjectCreateInput } from "./config-backed-projects";
import { type AgentProvider, type ProjectSetupResult, type ProviderModelQuery } from "./domain";
import { loadEnvFiles, loadWorkflowEnv } from "./env";
import { createRootLoggerFromEnv } from "./logger";
import { migrateLegacyWorkflows } from "./migrate-legacy";
import { createPlatformContext } from "./platform-context";
import { DashboardServerHost } from "./platform-module";
import { getActiveProviderRegistry } from "./provider-registry";
import { parseWorkflowFile } from "./workflow";

type ParsedArgs = {
  flags: Map<string, string | boolean>;
  positionals: string[];
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  const subcommand = rest[0];

  if (!command || command === "run-all") {
    await runCombined(rest);
    return;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "init":
      await runInit(rest);
      return;
    case "run":
      await runRuntime(rest);
      return;
    case "dashboard":
      await runDashboard(rest);
      return;
    case "tui":
      await runTui(rest);
      return;
    case "providers":
      if (subcommand === "list") {
        await runProvidersList(rest.slice(1));
        return;
      }
      break;
    case "models":
      if (subcommand === "list") {
        await runModelsList(rest.slice(1));
        return;
      }
      break;
    case "project":
      if (subcommand === "add") {
        await runProjectAdd(rest.slice(1));
        return;
      }
      break;
    case "migrate":
      if (subcommand === "legacy") {
        await runMigrateLegacy(rest.slice(1));
        return;
      }
      break;
    case "doctor":
      await runDoctor(rest);
      return;
    default:
      break;
  }

  throw new Error(`Unknown command: ${argv.join(" ")}`);
}

async function runInit(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  await platform.close();
  process.stdout.write(`Initialized OrchestrAI at ${projectsRoot}\n`);
}

async function runRuntime(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  await platform.controlPlane.startRuntime();
  process.stdout.write(`Runtime started for ${projectsRoot}\n`);
  await waitForShutdown(async () => {
    await platform.close();
  });
}

async function runDashboard(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const host = normalizeHost(flagString(parsed, "host") ?? "127.0.0.1");
  const port = parsePositiveInteger(flagString(parsed, "port")) ?? 4318;
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  const dashboard = new DashboardServerHost(platform.controlPlane, logger);
  const info = await dashboard.start(port, host);
  process.stdout.write(`Dashboard running at ${info.url}\n`);
  await waitForShutdown(async () => {
    await dashboard.stop().catch(() => undefined);
    await platform.close();
  });
}

async function runCombined(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const host = normalizeHost(flagString(parsed, "host") ?? "127.0.0.1");
  const port = parsePositiveInteger(flagString(parsed, "port")) ?? 4318;
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  const dashboard = new DashboardServerHost(platform.controlPlane, logger);
  await platform.controlPlane.startRuntime();
  const info = await dashboard.start(port, host);
  process.stdout.write(`Runtime started.\nDashboard running at ${info.url}\n`);
  await waitForShutdown(async () => {
    await dashboard.stop().catch(() => undefined);
    await platform.close();
  });
}

async function runTui(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const tuiEntryPath = path.resolve(__dirname, "..", "tui.mjs");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tuiEntryPath, projectsRoot], {
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`TUI exited from signal ${signal}`));
        return;
      }
      if (typeof code === "number" && code !== 0) {
        reject(new Error(`TUI exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function runProvidersList(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed, true);
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  try {
    const providers = platform.controlPlane.listProviders();
    for (const provider of providers) {
      process.stdout.write(`${provider.id}\t${provider.displayName}\tdefault=${provider.defaultModel}\n`);
    }
  } finally {
    await platform.close();
  }
}

async function runModelsList(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed);
  const provider = requireFlag(parsed, "provider", parsed.positionals[0]);
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  try {
    const query: ProviderModelQuery = {
      provider,
      projectId: flagString(parsed, "project-id") ?? null,
      xaiApiKey: flagString(parsed, "xai-api-key") ?? null,
      useStoredKey: flagBoolean(parsed, "use-stored-key")
    };
    const catalog = await platform.controlPlane.listProviderModels(query);
    process.stdout.write(`# ${catalog.provider} (${catalog.source})\n`);
    if (catalog.warning) {
      process.stdout.write(`warning: ${catalog.warning}\n`);
    }
    for (const model of catalog.models) {
      process.stdout.write(`${model.value}\t${model.label}\n`);
    }
  } finally {
    await platform.close();
  }
}

async function runProjectAdd(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed);
  const cloneRepository = flagString(parsed, "clone");
  const existingPath = flagString(parsed, "path");
  if (!cloneRepository && !existingPath) {
    throw new Error("project add requires either --clone <repo> or --path <directory>");
  }
  if (cloneRepository && existingPath) {
    throw new Error("project add accepts only one source: --clone or --path");
  }

  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  try {
    const input = buildProjectAddInput(parsed, cloneRepository, existingPath);
    const created = await platform.controlPlane.createProject(input);
    renderProjectResult("Created project", created);
  } finally {
    await platform.close();
  }
}

async function runMigrateLegacy(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed);
  const legacyTarget = flagString(parsed, "from") ?? parsed.positionals[0];
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const report = await migrateLegacyWorkflows(legacyTarget, projectsRoot, env);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  await platform.close();
  process.stdout.write(`Migrated ${report.migratedProjects.length} project(s) into ${report.projectsRoot}\n`);
  for (const project of report.migratedProjects) {
    process.stdout.write(`- ${project.id}\t${project.workflowPath}\t${project.promptPath}\n`);
  }
}

async function runDoctor(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectsRoot = resolveProjectsRoot(parsed);
  const logger = createRootLoggerFromEnv();
  const env = await loadRootEnv(projectsRoot, logger);
  const platform = await createPlatformContext(projectsRoot, env, logger);
  let hasErrors = false;

  try {
    const registry = getActiveProviderRegistry();
    const globalConfig = await platform.controlPlane.readGlobalConfig();
    if (!registry.maybeGet(globalConfig.defaults.agentProvider)) {
      process.stdout.write(`[error] global default provider "${globalConfig.defaults.agentProvider}" is not registered\n`);
      hasErrors = true;
    } else {
      process.stdout.write(`[info] global default provider "${globalConfig.defaults.agentProvider}" is available\n`);
    }

    const projects = await platform.controlPlane.listProjects();
    if (projects.length === 0) {
      process.stdout.write("[info] no projects configured\n");
    }

    for (const project of projects) {
      try {
        const workflowSource = await readFile(project.workflowPath, "utf8");
        const envForWorkflow = await loadWorkflowEnv(
          path.dirname(project.workflowPath),
          env,
          logger.child({ component: "doctor-env" }),
          projectsRoot
        );
        const workflow = parseWorkflowFile(workflowSource);
        const config = buildServiceConfig(project.workflowPath, workflow, envForWorkflow);
        const plugin = registry.get(config.runtime.provider);

        plugin.validateConfig?.(config);
        process.stdout.write(`[info] ${project.id}: provider "${plugin.id}" resolved\n`);

        const findings = (await plugin.doctor?.(config, envForWorkflow)) ?? [];
        for (const finding of findings) {
          process.stdout.write(`[${finding.level}] ${project.id}: ${finding.message}\n`);
          if (finding.level === "error") {
            hasErrors = true;
          }
        }
      } catch (error) {
        hasErrors = true;
        process.stdout.write(
          `[error] ${project.id}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  } finally {
    await platform.close();
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}

function buildProjectAddInput(
  parsed: ParsedArgs,
  cloneRepository: string | undefined,
  existingPath: string | undefined
): ConfigBackedProjectCreateInput {
  const linearProjectSlug = requireFlag(parsed, "slug");
  const githubRepository = flagString(parsed, "repo") ?? normalizeGithubRepository(cloneRepository ?? "") ?? "";
  const agentProvider = flagString(parsed, "provider");
  const agentModel = flagString(parsed, "model");
  const codexReasoningEffort = flagString(parsed, "codex-reasoning-effort");
  const input: ConfigBackedProjectCreateInput = {
    id: flagString(parsed, "id") ?? null,
    displayName: flagString(parsed, "name") ?? null,
    projectSlug: linearProjectSlug,
    githubRepository,
    linearApiKey: flagString(parsed, "linear-api-key") ?? null,
    xaiApiKey: flagString(parsed, "xai-api-key") ?? null,
    githubToken: flagString(parsed, "github-token") ?? null,
    agentProvider: (agentProvider ?? null) as AgentProvider | null,
    agentModel: agentModel ?? null,
    codexReasoningEffort: codexReasoningEffort ?? null,
    useGlobalAgentProvider: !agentProvider,
    useGlobalAgentModel: !agentModel,
    useGlobalCodexReasoningEffort: !codexReasoningEffort,
    pollingIntervalMs: parsePositiveInteger(flagString(parsed, "polling-interval-ms")),
    maxConcurrentAgents: parsePositiveInteger(flagString(parsed, "max-concurrent-agents")),
    useGlobalLinearApiKey: !flagString(parsed, "linear-api-key"),
    useGlobalXaiApiKey: !flagString(parsed, "xai-api-key"),
    useGlobalGithubToken: !flagString(parsed, "github-token"),
    useGlobalPollingIntervalMs: !flagString(parsed, "polling-interval-ms"),
    useGlobalMaxConcurrentAgents: !flagString(parsed, "max-concurrent-agents"),
    source: cloneRepository
      ? {
          kind: "clone",
          repository: cloneRepository
        }
      : {
          kind: "existingPath",
          path: path.resolve(requireFlag(parsed, "path", existingPath))
        }
  };
  return input;
}

function renderProjectResult(prefix: string, project: ProjectSetupResult): void {
  process.stdout.write(
    `${prefix}: ${project.id} provider=${project.agentProvider} model=${project.agentModel} workflow=${project.workflowPath}\n`
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const trimmed = argument.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      flags.set(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      flags.set(trimmed, next);
      index += 1;
      continue;
    }

    flags.set(trimmed, true);
  }

  return { flags, positionals };
}

function resolveProjectsRoot(parsed: ParsedArgs, allowPositionalRoot = false): string {
  const rootArg = flagString(parsed, "root") ?? (allowPositionalRoot ? parsed.positionals[0] : undefined);
  return path.resolve(rootArg ?? process.cwd());
}

async function loadRootEnv(projectsRoot: string, logger: ReturnType<typeof createRootLoggerFromEnv>): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  await loadEnvFiles(projectsRoot, env, logger.child({ component: "global-env" }));
  return env;
}

function requireFlag(parsed: ParsedArgs, name: string, fallback?: string): string {
  const value = flagString(parsed, name) ?? fallback;
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value.trim();
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function flagBoolean(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags.get(name);
  return value === true || value === "true";
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeGithubRepository(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  return normalized.includes("/") ? normalized : null;
}

function normalizeHost(value: string): string {
  return value.trim() || "127.0.0.1";
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = async () => {
      if (closing) {
        return;
      }
      closing = true;
      await stop().catch(() => undefined);
      resolve();
    };

    process.on("SIGINT", () => {
      void close();
    });
    process.on("SIGTERM", () => {
      void close();
    });
  });
}

function printHelp(): void {
  process.stdout.write(`OrchestrAI CLI

Usage:
  orchestrai init [--root <dir>]
  orchestrai run [--root <dir>]
  orchestrai dashboard [--root <dir>] [--host <host>] [--port <port>]
  orchestrai tui [--root <dir>]
  orchestrai providers list [--root <dir>]
  orchestrai models list --provider <id> [--root <dir>] [--project-id <id>] [--use-stored-key] [--xai-api-key <key>]
  orchestrai project add --slug <linear-project> (--clone <repo> | --path <dir>) [--repo <github/repo>] [--name <label>]
  orchestrai migrate legacy [--root <dir>] [--from <legacy-root-or-workflow>]
  orchestrai doctor [--root <dir>]
`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
