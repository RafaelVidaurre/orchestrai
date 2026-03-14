import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentProvider, FatalProjectError, Issue } from "./domain";
import { ServiceError, errorMessage } from "./errors";

const ORCHESTRAI_STATE_DIR = ".orchestrai";
const FATAL_ERROR_STATE_FILE = "fatal-error.json";
const FATAL_ERROR_LOG_FILE = "fatal-errors.ndjson";

const DIRECT_FATAL_CODES = new Set([
  "unsupported_tracker_kind",
  "missing_tracker_api_key",
  "missing_tracker_project_slug",
  "missing_codex_command",
  "missing_claude_command",
  "missing_grok_api_key",
  "invalid_workspace_root",
  "codex_not_found",
  "claude_not_found",
  "grok_auth_error"
]);

export interface FatalRuntimeErrorInput {
  workflowPath: string;
  provider: AgentProvider | null;
  stage: FatalProjectError["stage"];
  error: unknown;
  issue?: Pick<Issue, "id" | "identifier" | "title"> | null;
}

export function classifyFatalRuntimeError(
  input: Omit<FatalRuntimeErrorInput, "workflowPath">
): Omit<FatalProjectError, "timestamp" | "workflow_path" | "log_path"> | null {
  const serviceError = input.error instanceof ServiceError ? input.error : null;
  if (!serviceError) {
    return null;
  }

  const details = normalizeErrorDetails(serviceError.details);
  const statusCode = extractStatusCode(details, serviceError.message);
  if (!DIRECT_FATAL_CODES.has(serviceError.code)) {
    const authFailure =
      (serviceError.code === "grok_api_status" || serviceError.code === "linear_api_status") &&
      (statusCode === 401 || statusCode === 403);
    if (!authFailure) {
      return null;
    }
  }

  return {
    provider: input.provider,
    stage: input.stage,
    code: serviceError.code,
    message: serviceError.message.trim() || errorMessage(input.error),
    details: details || statusCode !== null ? mergeStatusDetail(details, statusCode) : null,
    issue_id: input.issue?.id ?? null,
    issue_identifier: input.issue?.identifier ?? null,
    issue_title: input.issue?.title ?? null
  };
}

export async function recordFatalProjectError(input: FatalRuntimeErrorInput): Promise<FatalProjectError> {
  const classified = classifyFatalRuntimeError(input);
  if (!classified) {
    throw new Error("recordFatalProjectError called with a non-fatal error");
  }

  const runtimeDir = fatalRuntimeDirectory(input.workflowPath);
  const statePath = fatalProjectErrorStatePath(input.workflowPath);
  const logPath = fatalProjectErrorLogPath(input.workflowPath);
  const record: FatalProjectError = {
    ...classified,
    timestamp: new Date().toISOString(),
    workflow_path: path.resolve(input.workflowPath),
    log_path: logPath
  };

  await mkdir(runtimeDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function readFatalProjectError(workflowPath: string): Promise<FatalProjectError | null> {
  const statePath = fatalProjectErrorStatePath(workflowPath);
  const content = await readFile(statePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  });
  if (!content) {
    return null;
  }

  try {
    return normalizeFatalProjectError(JSON.parse(content), workflowPath);
  } catch {
    return null;
  }
}

export async function clearFatalProjectError(workflowPath: string): Promise<void> {
  await rm(fatalProjectErrorStatePath(workflowPath), { force: true });
}

export function fatalProjectErrorLogPath(workflowPath: string): string {
  return path.join(fatalRuntimeDirectory(workflowPath), FATAL_ERROR_LOG_FILE);
}

function fatalProjectErrorStatePath(workflowPath: string): string {
  return path.join(fatalRuntimeDirectory(workflowPath), FATAL_ERROR_STATE_FILE);
}

function fatalRuntimeDirectory(workflowPath: string): string {
  return path.join(path.dirname(path.resolve(workflowPath)), ORCHESTRAI_STATE_DIR);
}

function normalizeFatalProjectError(value: unknown, workflowPath: string): FatalProjectError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    return null;
  }

  return {
    timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString(),
    workflow_path: typeof record.workflow_path === "string" ? record.workflow_path : path.resolve(workflowPath),
    provider: normalizeProvider(record.provider),
    stage: normalizeStage(record.stage),
    code: record.code,
    message: record.message,
    details: normalizeErrorDetails(record.details),
    issue_id: typeof record.issue_id === "string" ? record.issue_id : null,
    issue_identifier: typeof record.issue_identifier === "string" ? record.issue_identifier : null,
    issue_title: typeof record.issue_title === "string" ? record.issue_title : null,
    log_path: typeof record.log_path === "string" ? record.log_path : fatalProjectErrorLogPath(workflowPath)
  };
}

function normalizeProvider(value: unknown): AgentProvider | null {
  return value === "codex" || value === "claude" || value === "grok" ? value : null;
}

function normalizeStage(value: unknown): FatalProjectError["stage"] {
  switch (value) {
    case "startup":
    case "dispatch":
    case "worker":
    case "retry":
    case "reconcile":
      return value;
    default:
      return "worker";
  }
}

function normalizeErrorDetails(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractStatusCode(details: Record<string, unknown> | null, message: string): number | null {
  const statusValue = details?.status;
  if (typeof statusValue === "number" && Number.isFinite(statusValue)) {
    return Math.trunc(statusValue);
  }
  if (typeof statusValue === "string" && statusValue.trim().length > 0) {
    const parsed = Number.parseInt(statusValue, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const match = /\b(?:HTTP|responded with)\s+(\d{3})\b/i.exec(message);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeStatusDetail(details: Record<string, unknown> | null, statusCode: number | null): Record<string, unknown> | null {
  if (statusCode === null) {
    return details;
  }

  return {
    ...(details ?? {}),
    status: statusCode
  };
}
