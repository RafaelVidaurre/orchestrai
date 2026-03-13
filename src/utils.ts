import os from "node:os";
import path from "node:path";

import type { Issue, ServiceConfig } from "./domain";

export const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function normalizeState(state: string | null | undefined): string {
  return (state ?? "").trim().toLowerCase();
}

export function isTerminalState(state: string, config: ServiceConfig): boolean {
  return config.tracker.terminalStates.some((candidate) => normalizeState(candidate) === normalizeState(state));
}

export function isActiveState(state: string, config: ServiceConfig): boolean {
  return config.tracker.activeStates.some((candidate) => normalizeState(candidate) === normalizeState(state));
}

export function computeRetryDelayMs(attempt: number, maxBackoffMs: number, continuation: boolean): number {
  if (continuation) {
    return 1000;
  }

  return Math.min(10000 * 2 ** Math.max(attempt - 1, 0), maxBackoffMs);
}

export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = Number.isInteger(left.priority) ? (left.priority as number) : Number.MAX_SAFE_INTEGER;
    const rightPriority = Number.isInteger(right.priority) ? (right.priority as number) : Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreated = left.created_at ? Date.parse(left.created_at) : Number.MAX_SAFE_INTEGER;
    const rightCreated = right.created_at ? Date.parse(right.created_at) : Number.MAX_SAFE_INTEGER;
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

export function pathWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);

  if (normalizedRoot === normalizedCandidate) {
    return true;
  }

  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function truncate(value: string, max = 4000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}...`;
}

export function expandPathLikeValue(value: string, env: NodeJS.ProcessEnv): string {
  let next = value;
  if (next.startsWith("$")) {
    next = env[next.slice(1)] ?? "";
  }

  if (next.startsWith("~")) {
    next = path.join(os.homedir(), next.slice(1));
  }

  return path.resolve(next);
}

export function resolveSecretValue(value: unknown, env: NodeJS.ProcessEnv, fallbackEnvKey?: string): string {
  if (typeof value === "string") {
    if (value.startsWith("$")) {
      return env[value.slice(1)] ?? "";
    }

    return value;
  }

  if (fallbackEnvKey) {
    return env[fallbackEnvKey] ?? "";
  }

  return "";
}
