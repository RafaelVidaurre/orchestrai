import type { OperatorEvent, StatusRetryEntry, StatusRunningEntry } from "./domain";

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

  const normalizedWidth = Math.max(width, 56);
  const columns = resolveAgentColumns(normalizedWidth);
  const header = [
    fitCell("ID", columns.identifier),
    fitCell("PROJECT", columns.project),
    fitCell("AGE", columns.age),
    fitCell("PHASE", columns.phase),
    fitCell("ACTIVITY", columns.activity)
  ].join("  ");

  return [
    header,
    ...entries.slice(0, 14).map((entry) =>
      [
        fitCell(entry.identifier, columns.identifier),
        fitCell(entry.project_name ?? entry.project_slug, columns.project),
        fitCell(formatElapsedShort(nowMs - entry.started_at_ms), columns.age),
        fitCell(compactActivity(humanizePhase(entry.phase)), columns.phase),
        fitCell(compactActivity(entry.activity), columns.activity)
      ].join("  ")
    )
  ];
}

export function buildEventLines(events: OperatorEvent[], width: number): string[] {
  if (events.length === 0) {
    return ["No recent events."];
  }

  const normalizedWidth = Math.max(width, 56);
  const columns = {
    time: 8,
    issue: normalizedWidth >= 72 ? 12 : 10,
    message: Math.max(12, normalizedWidth - 8 - (normalizedWidth >= 72 ? 12 : 10) - 4)
  };

  const header = [
    fitCell("WHEN", columns.time),
    fitCell("ISSUE", columns.issue),
    fitCell("EVENT", columns.message)
  ].join("  ");

  return [
    header,
    ...events.slice(0, 8).map((event) =>
      [
        fitCell(formatEventAge(event.timestamp), columns.time),
        fitCell(event.issueIdentifier ?? "runtime", columns.issue),
        fitCell(compactActivity(describeEvent(event)), columns.message)
      ].join("  ")
    )
  ];
}

export function buildRetryLines(entries: StatusRetryEntry[], width: number, nowMs: number): string[] {
  if (entries.length === 0) {
    return ["No queued retries."];
  }

  const normalizedWidth = Math.max(width, 56);
  const columns = {
    identifier: normalizedWidth >= 72 ? 12 : 10,
    due: normalizedWidth >= 72 ? 10 : 8,
    title: Math.max(12, normalizedWidth - (normalizedWidth >= 72 ? 12 : 10) - (normalizedWidth >= 72 ? 10 : 8) - 4)
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
  age: number;
  phase: number;
  activity: number;
} {
  const identifier = width >= 72 ? 10 : 9;
  const project = width >= 120 ? 16 : width >= 72 ? 12 : 10;
  const age = width >= 72 ? 9 : 7;
  const phase = width >= 120 ? 16 : width >= 72 ? 12 : 9;
  const used = identifier + project + age + phase + 8;
  return {
    identifier,
    project,
    age,
    phase,
    activity: Math.max(12, width - used)
  };
}

function humanizePhase(phase: string): string {
  switch (phase) {
    case "preparing_workspace":
      return "preparing";
    case "running_before_run_hook":
      return "preflight";
    case "launching_agent_process":
      return "launching";
    case "initializing_session":
      return "init";
    case "building_prompt":
      return "planning";
    case "streaming_turn":
      return "working";
    case "refreshing_issue_state":
      return "syncing";
    case "finishing":
      return "finishing";
    default:
      return phase;
  }
}

function formatEventAge(timestamp: string): string {
  const elapsedMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1000) {
    return "now";
  }

  return formatElapsedShort(elapsedMs);
}

function describeEvent(event: OperatorEvent): string {
  if (event.message === "worker activity" && typeof event.fields?.activity === "string") {
    return event.fields.activity;
  }

  if (event.message === "retry scheduled") {
    return typeof event.fields?.delay_ms === "number"
      ? `retry in ${formatElapsedShort(event.fields.delay_ms)}`
      : "retry scheduled";
  }

  if (event.message === "issue dispatched") {
    return `picked up from ${String(event.fields?.state ?? "active")}`;
  }

  return event.message.replace(/^(codex|claude|grok) /, "");
}
