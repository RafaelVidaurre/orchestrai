import type { StatusRetryEntry, StatusRunningEntry } from "./domain";

export function formatElapsedShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

export function buildAgentTableLines(entries: StatusRunningEntry[], width: number, nowMs: number): string[] {
  if (entries.length === 0) {
    return ["No active agents."];
  }

  const normalizedWidth = Math.max(width, 88);
  const columns = resolveAgentColumns(normalizedWidth);
  const header = [
    fitCell("ID", columns.identifier),
    fitCell("PROJECT", columns.project),
    fitCell("STATE", columns.state),
    fitCell("AGE", columns.age),
    fitCell("TOKENS", columns.tokens),
    fitCell("ACTIVITY", columns.activity)
  ].join("  ");

  return [
    header,
    ...entries.slice(0, 14).map((entry) =>
      [
        fitCell(entry.identifier, columns.identifier),
        fitCell(entry.project_name ?? entry.project_slug, columns.project),
        fitCell(entry.state, columns.state),
        fitCell(formatElapsedShort(nowMs - entry.started_at_ms), columns.age),
        fitCell(formatInteger(entry.codex_total_tokens), columns.tokens),
        fitCell(compactActivity(entry.activity), columns.activity)
      ].join("  ")
    )
  ];
}

export function buildRetryLines(entries: StatusRetryEntry[], width: number, nowMs: number): string[] {
  if (entries.length === 0) {
    return ["No queued retries."];
  }

  const normalizedWidth = Math.max(width, 72);
  const columns = {
    identifier: 12,
    due: 10,
    title: Math.max(20, normalizedWidth - 12 - 10 - 4)
  };

  const header = [
    fitCell("ID", columns.identifier),
    fitCell("DUE", columns.due),
    fitCell("TITLE", columns.title)
  ].join("  ");

  return [
    header,
    ...entries.slice(0, 6).map((entry) =>
      [
        fitCell(entry.identifier, columns.identifier),
        fitCell(formatElapsedShort(Math.max(0, entry.due_at_ms - nowMs)), columns.due),
        fitCell(entry.title, columns.title)
      ].join("  ")
    )
  ];
}

export function compactActivity(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned;
}

export function fitCell(value: string, width: number): string {
  const truncated = value.length > width ? `${value.slice(0, Math.max(0, width - 3))}...` : value;
  return truncated.padEnd(width, " ");
}

function resolveAgentColumns(width: number): {
  identifier: number;
  project: number;
  state: number;
  age: number;
  tokens: number;
  activity: number;
} {
  const identifier = 10;
  const project = width >= 120 ? 16 : 12;
  const state = 12;
  const age = 9;
  const tokens = width >= 120 ? 12 : 10;
  const used = identifier + project + state + age + tokens + 10;
  return {
    identifier,
    project,
    state,
    age,
    tokens,
    activity: Math.max(24, width - used)
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}
