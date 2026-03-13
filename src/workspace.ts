import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ServiceConfig, WorkspaceInfo } from "./domain";
import { ServiceError } from "./errors";
import { Logger } from "./logger";
import { pathWithinRoot, sanitizeWorkspaceKey, truncate } from "./utils";

const PREP_ARTIFACTS = ["tmp", ".elixir_ls"];

export class WorkspaceManager {
  constructor(private readonly logger: Logger) {}

  async ensureWorkspace(config: ServiceConfig, issueIdentifier: string, env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceInfo> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(config.workspace.root, workspaceKey);
    assertWorkspacePath(config.workspace.root, workspacePath);

    await mkdir(config.workspace.root, { recursive: true });

    let createdNow = false;
    try {
      const existing = await stat(workspacePath);
      if (!existing.isDirectory()) {
        throw new ServiceError("invalid_workspace_path", "Workspace path already exists and is not a directory", {
          workspace_path: workspacePath
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      await mkdir(workspacePath, { recursive: true });
      createdNow = true;
    }

    if (createdNow && config.hooks.afterCreate) {
      try {
        await runHook("after_create", config.hooks.afterCreate, workspacePath, config.hooks.timeoutMs, env, this.logger);
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true });
        throw error;
      }
    }

    return {
      path: workspacePath,
      workspaceKey,
      createdNow,
      runPath: await this.resolveExecutionPath(config, workspacePath)
    };
  }

  async prepareWorkspace(config: ServiceConfig, workspacePath: string): Promise<void> {
    assertWorkspacePath(config.workspace.root, workspacePath);

    for (const artifact of PREP_ARTIFACTS) {
      const artifactPath = path.join(workspacePath, artifact);
      try {
        await access(artifactPath);
        await rm(artifactPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  async runBeforeRun(config: ServiceConfig, workspacePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!config.hooks.beforeRun) {
      return;
    }

    const executionPath = await this.resolveExecutionPath(config, workspacePath);
    await runHook("before_run", config.hooks.beforeRun, executionPath, config.hooks.timeoutMs, env, this.logger);
  }

  async runAfterRun(config: ServiceConfig, workspacePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!config.hooks.afterRun) {
      return;
    }

    const executionPath = await this.resolveExecutionPath(config, workspacePath);
    try {
      await runHook("after_run", config.hooks.afterRun, executionPath, config.hooks.timeoutMs, env, this.logger);
    } catch (error) {
      this.logger.errorWithCause("after_run hook failed", error, {
        workspace_path: executionPath
      });
    }
  }

  async removeWorkspace(config: ServiceConfig, issueIdentifier: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(config.workspace.root, workspaceKey);
    assertWorkspacePath(config.workspace.root, workspacePath);

    try {
      const existing = await stat(workspacePath);
      if (!existing.isDirectory()) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const executionPath = await this.resolveExecutionPath(config, workspacePath);

    if (config.hooks.beforeRemove) {
      try {
        await runHook("before_remove", config.hooks.beforeRemove, executionPath, config.hooks.timeoutMs, env, this.logger);
      } catch (error) {
        this.logger.errorWithCause("before_remove hook failed", error, {
          workspace_path: executionPath
        });
      }
    }

    await rm(workspacePath, { recursive: true, force: true });
    this.logger.info("workspace removed", {
      workspace_path: workspacePath
    });
  }

  async listWorkspaceKeys(config: ServiceConfig): Promise<string[]> {
    await mkdir(config.workspace.root, { recursive: true });
    const entries = await readdir(config.workspace.root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  async resolveExecutionPath(config: ServiceConfig, workspacePath: string): Promise<string> {
    assertWorkspacePath(config.workspace.root, workspacePath);

    if (await hasGitMarker(workspacePath)) {
      return workspacePath;
    }

    const entries = await readdir(workspacePath, { withFileTypes: true });
    const repoChildren: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childPath = path.join(workspacePath, entry.name);
      if (await hasGitMarker(childPath)) {
        repoChildren.push(childPath);
      }
    }

    if (repoChildren.length === 1) {
      const resolved = repoChildren[0];
      assertWorkspacePath(config.workspace.root, resolved);
      this.logger.debug("workspace execution path resolved to nested repository", {
        workspace_path: workspacePath,
        execution_path: resolved
      });
      return resolved;
    }

    return workspacePath;
  }
}

export function assertWorkspacePath(root: string, workspacePath: string): void {
  if (!pathWithinRoot(root, workspacePath)) {
    throw new ServiceError("invalid_workspace_cwd", "Workspace path escapes the configured root", {
      workspace_root: root,
      workspace_path: workspacePath
    });
  }
}

async function runHook(
  hookName: string,
  script: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  logger: Logger
): Promise<void> {
  logger.info("hook started", {
    hook: hookName,
    workspace_path: cwd
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.push(String(chunk));
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new ServiceError("hook_timeout", `Hook ${hookName} timed out`, {
            hook: hookName,
            workspace_path: cwd
          })
        );
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new ServiceError("hook_failed", `Hook ${hookName} failed`, {
          hook: hookName,
          workspace_path: cwd,
          exit_code: code,
          signal,
          stdout: truncate(stdout.join("")),
          stderr: truncate(stderr.join(""))
        })
      );
    });
  });
}

async function hasGitMarker(candidatePath: string): Promise<boolean> {
  try {
    await access(path.join(candidatePath, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
