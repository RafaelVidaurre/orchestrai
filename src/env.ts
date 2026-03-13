import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";

import { Logger } from "./logger";

export async function loadEnvFiles(baseDir: string, env: NodeJS.ProcessEnv = process.env, logger?: Logger): Promise<void> {
  const protectedKeys = new Set(Object.keys(env));

  await applyEnvFile(path.join(baseDir, ".env"), env, protectedKeys, logger);
  await applyEnvFile(path.join(baseDir, ".env.local"), env, protectedKeys, logger);
}

async function applyEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  protectedKeys: ReadonlySet<string>,
  logger?: Logger
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const parsed = parse(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (protectedKeys.has(key)) {
      continue;
    }
    env[key] = value;
  }

  logger?.info("env file loaded", {
    env_file: filePath
  });
}
