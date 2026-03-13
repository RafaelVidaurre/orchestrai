import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";

import type { GlobalConfigInput, GlobalConfigRecord } from "./domain";
import { ServiceError } from "./errors";
import { loadEnvFiles } from "./env";

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

export async function readGlobalConfig(
  projectsRoot: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<GlobalConfigRecord> {
  const env = { ...baseEnv };
  const root = path.resolve(projectsRoot);
  await loadEnvFiles(root, env);

  return {
    projectsRoot: root,
    envFilePath: path.join(root, ".env.local"),
    defaults: {
      pollingIntervalMs: coercePositiveInteger(env.ORCHESTRAI_DEFAULT_POLLING_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
      maxConcurrentAgents: coercePositiveInteger(
        env.ORCHESTRAI_DEFAULT_MAX_CONCURRENT_AGENTS,
        DEFAULT_MAX_CONCURRENT_AGENTS
      )
    },
    hasLinearApiKey: typeof env.LINEAR_API_KEY === "string" && env.LINEAR_API_KEY.length > 0,
    hasGithubToken: typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0
  };
}

export async function updateGlobalConfig(
  projectsRoot: string,
  input: GlobalConfigInput,
  runtimeEnv: NodeJS.ProcessEnv
): Promise<GlobalConfigRecord> {
  const root = path.resolve(projectsRoot);
  const envFilePath = path.join(root, ".env.local");
  const current = await readLooseEnvFile(envFilePath);
  const effective = await readGlobalConfig(root, runtimeEnv);

  const next: Record<string, string | undefined> = {
    ...current,
    ORCHESTRAI_DEFAULT_POLLING_INTERVAL_MS: String(
      coercePositiveInteger(input.pollingIntervalMs, effective.defaults.pollingIntervalMs)
    ),
    ORCHESTRAI_DEFAULT_MAX_CONCURRENT_AGENTS: String(
      coercePositiveInteger(input.maxConcurrentAgents, effective.defaults.maxConcurrentAgents)
    )
  };

  if (input.clearLinearApiKey) {
    delete next.LINEAR_API_KEY;
  } else if (typeof input.linearApiKey === "string" && input.linearApiKey.trim().length > 0) {
    next.LINEAR_API_KEY = input.linearApiKey.trim();
  }

  if (input.clearGithubToken) {
    delete next.GITHUB_TOKEN;
  } else if (typeof input.githubToken === "string" && input.githubToken.trim().length > 0) {
    next.GITHUB_TOKEN = input.githubToken.trim();
  }

  await writeEnvFile(envFilePath, next);
  applyGlobalEnv(runtimeEnv, next);
  return readGlobalConfig(root, runtimeEnv);
}

export function applyGlobalEnv(runtimeEnv: NodeJS.ProcessEnv, values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length > 0) {
      runtimeEnv[key] = value;
    } else {
      delete runtimeEnv[key];
    }
  }
}

export function validateGlobalConfigInput(value: unknown): GlobalConfigInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_project_setup", "Global config payload must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  return {
    pollingIntervalMs: typeof input.pollingIntervalMs === "number" ? input.pollingIntervalMs : null,
    maxConcurrentAgents: typeof input.maxConcurrentAgents === "number" ? input.maxConcurrentAgents : null,
    linearApiKey: typeof input.linearApiKey === "string" ? input.linearApiKey : null,
    githubToken: typeof input.githubToken === "string" ? input.githubToken : null,
    clearLinearApiKey: input.clearLinearApiKey === true,
    clearGithubToken: input.clearGithubToken === true
  };
}

async function readLooseEnvFile(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  return parse(content);
}

async function writeEnvFile(filePath: string, values: Record<string, string | undefined>): Promise<void> {
  const lines = Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
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
