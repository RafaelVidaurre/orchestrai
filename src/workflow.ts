import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { Liquid } from "liquidjs";
import YAML from "yaml";

import { buildServiceConfig } from "./config";
import type { Issue, LoadedWorkflow, WorkflowDefinition } from "./domain";
import { ServiceError } from "./errors";
import { Logger } from "./logger";

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true
});

const DEFAULT_WORKFLOW_FILE = "WORKFLOW.md";
const DEFAULT_WORKFLOWS_DIR = "workflows";

export interface WorkflowContext {
  targetPath: string;
  workflowPaths: string[];
  projectsRoot: string;
}

export class WorkflowManager {
  private current: LoadedWorkflow | null = null;
  private dirty = true;
  private watcher: ReturnType<typeof watch> | null = null;
  private version = 0;

  constructor(
    private readonly workflowPath: string,
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async start(): Promise<void> {
    await this.reload({ allowStale: false });
    this.startWatcher();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  async getCurrent(): Promise<LoadedWorkflow> {
    return this.reload({ allowStale: true });
  }

  private async reload(options: { allowStale: boolean }): Promise<LoadedWorkflow> {
    if (!this.dirty && this.current) {
      return this.current;
    }

    try {
      const content = await readFile(this.workflowPath, "utf8");
      const definition = parseWorkflowFile(content);
      const config = buildServiceConfig(this.workflowPath, definition, this.env);
      const next: LoadedWorkflow = {
        definition,
        config,
        version: ++this.version,
        env: this.env
      };
      const changed = !this.current || JSON.stringify(this.current.config) !== JSON.stringify(next.config);
      this.current = next;
      this.dirty = false;
      if (changed) {
        this.logger.info("workflow loaded", {
          workflow_path: this.workflowPath,
          workflow_version: next.version
        });
      }
      return next;
    } catch (error) {
      this.dirty = false;
      if (options.allowStale && this.current) {
        this.logger.errorWithCause("workflow reload failed; keeping last known good configuration", error, {
          workflow_path: this.workflowPath
        });
        return this.current;
      }

      throw mapWorkflowError(error, this.workflowPath);
    }
  }

  private startWatcher(): void {
    this.watcher = watch(this.workflowPath, () => {
      this.dirty = true;
    });
  }
}

export async function resolveWorkflowPaths(candidate?: string): Promise<string[]> {
  const context = await resolveWorkflowContext(candidate);
  return context.workflowPaths;
}

export async function resolveWorkflowContext(
  candidate?: string,
  options: {
    allowEmpty?: boolean;
  } = {}
): Promise<WorkflowContext> {
  const targetPath = candidate ? path.resolve(candidate) : await resolveDefaultWorkflowTarget(process.cwd());
  const allowEmpty = options.allowEmpty ?? false;

  const targetStat = await stat(targetPath).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && allowEmpty) {
      return null;
    }

    throw mapWorkflowError(error, targetPath);
  });

  if (!targetStat) {
    return {
      targetPath,
      workflowPaths: [],
      projectsRoot: inferProjectsRoot(targetPath)
    };
  }

  if (targetStat.isDirectory()) {
    const workflows = await discoverWorkflowFiles(targetPath);
    if (workflows.length === 0 && !allowEmpty) {
      throw new ServiceError("missing_workflow_file", "No workflow files could be found", {
        workflow_path: targetPath
      });
    }
    return {
      targetPath,
      workflowPaths: workflows,
      projectsRoot: targetPath
    };
  }

  return {
    targetPath,
    workflowPaths: [targetPath],
    projectsRoot: inferProjectsRoot(targetPath)
  };
}

export function parseWorkflowFile(content: string): WorkflowDefinition {
  if (!content.startsWith("---")) {
    return {
      config: {},
      prompt_template: content.trim()
    };
  }

  const boundary = "\n---";
  const nextBoundary = content.indexOf(boundary, 3);
  if (nextBoundary === -1) {
    throw new ServiceError("workflow_parse_error", "Workflow front matter is missing a closing delimiter");
  }

  const frontMatter = content.slice(3, nextBoundary).trim();
  const body = content.slice(nextBoundary + boundary.length).trim();
  const parsed = frontMatter.length === 0 ? {} : YAML.parse(frontMatter);
  if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new ServiceError("workflow_front_matter_not_a_map", "Workflow front matter must decode to an object");
  }

  return {
    config: (parsed ?? {}) as Record<string, unknown>,
    prompt_template: body
  };
}

export async function renderPrompt(definition: WorkflowDefinition, issue: Issue, attempt: number | null): Promise<string> {
  const template = definition.prompt_template.trim().length > 0 ? definition.prompt_template : "You are working on an issue from Linear.";

  try {
    return await liquid.parseAndRender(template, {
      issue,
      attempt
    });
  } catch (error) {
    throw new ServiceError("template_render_error", "Failed to render workflow prompt", undefined, {
      cause: error instanceof Error ? error : undefined
    });
  }
}

function mapWorkflowError(error: unknown, workflowPath: string): ServiceError {
  if (error instanceof ServiceError) {
    return error;
  }

  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new ServiceError("missing_workflow_file", "Workflow file could not be found", {
      workflow_path: workflowPath
    });
  }

  if (error instanceof YAML.YAMLParseError) {
    return new ServiceError("workflow_parse_error", error.message, {
      workflow_path: workflowPath
    });
  }

  return new ServiceError("workflow_parse_error", error instanceof Error ? error.message : "Failed to parse workflow file", {
    workflow_path: workflowPath
  });
}

async function resolveDefaultWorkflowTarget(cwd: string): Promise<string> {
  const workflowsDir = path.join(cwd, DEFAULT_WORKFLOWS_DIR);
  try {
    const workflowsDirStat = await stat(workflowsDir);
    if (workflowsDirStat.isDirectory()) {
      return workflowsDir;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return path.join(cwd, DEFAULT_WORKFLOW_FILE);
}

async function discoverWorkflowFiles(root: string): Promise<string[]> {
  const discovered: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (entry.isFile() && isWorkflowFilename(entry.name)) {
        discovered.push(absolutePath);
      }
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

function isWorkflowFilename(fileName: string): boolean {
  return fileName === DEFAULT_WORKFLOW_FILE || fileName.endsWith(".workflow.md");
}

function inferProjectsRoot(targetPath: string): string {
  if (targetPath.endsWith(".md")) {
    return path.join(path.dirname(targetPath), DEFAULT_WORKFLOWS_DIR);
  }

  return targetPath;
}
