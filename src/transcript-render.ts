import type { AgentTranscriptEntry } from "./domain";

export type TranscriptRenderBlock =
  | {
      type: "item";
      entry: AgentTranscriptEntry;
    }
  | {
      type: "command-group";
      entries: AgentTranscriptEntry[];
    };

export function buildTranscriptRenderBlocks(entries: AgentTranscriptEntry[]): TranscriptRenderBlock[] {
  const blocks: TranscriptRenderBlock[] = [];
  let pendingCommands: AgentTranscriptEntry[] = [];

  const flushPending = () => {
    if (pendingCommands.length === 0) {
      return;
    }

    blocks.push({
      type: "command-group",
      entries: pendingCommands
    });
    pendingCommands = [];
  };

  for (const entry of entries) {
    if (isCompactCommandEntry(entry)) {
      pendingCommands.push(entry);
      continue;
    }

    flushPending();
    blocks.push({
      type: "item",
      entry
    });
  }

  flushPending();
  return blocks;
}

export function isCompactCommandEntry(entry: AgentTranscriptEntry): boolean {
  const message = entry.message.toLowerCase();
  return (
    entry.kind === "command" &&
    !message.startsWith("edited ") &&
    [
      "running command:",
      "finished command:",
      "command output streaming",
      "command completed",
      "submitting pull request",
      "pull request submitted",
      "checking pull request status",
      "pull request check finished",
      "pushing branch updates",
      "branch push finished",
      "committing changes",
      "commit finished",
      "running validation",
      "validation command finished",
      "reading project files",
      "file inspection finished",
      "reviewing repository state",
      "repository inspection finished"
    ].some((prefix) => message.startsWith(prefix))
  );
}

export function commandTooltip(entry: AgentTranscriptEntry): string {
  const message = entry.message.trim();
  for (const prefix of ["running command:", "finished command:"]) {
    if (message.toLowerCase().startsWith(prefix)) {
      const stripped = message.slice(prefix.length).trim();
      return stripped.length > 0 ? stripped : message;
    }
  }

  return message;
}

export function commandIconTone(entry: AgentTranscriptEntry): "running" | "done" | "special" {
  const message = entry.message.toLowerCase();
  if (
    message.startsWith("finished command:") ||
    message === "command completed" ||
    message === "pull request submitted" ||
    message === "branch push finished" ||
    message === "commit finished" ||
    message === "validation command finished" ||
    message === "pull request check finished" ||
    message === "file inspection finished" ||
    message === "repository inspection finished"
  ) {
    return "done";
  }

  if (
    message.includes("pull request") ||
    message.includes("validation") ||
    message.includes("commit") ||
    message.includes("push")
  ) {
    return "special";
  }

  return "running";
}
