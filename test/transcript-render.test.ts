import { describe, expect, it } from "vitest";

import type { AgentTranscriptEntry } from "../src/domain";
import { buildTranscriptRenderBlocks, commandIconTone, commandTooltip, isCompactCommandEntry } from "../src/transcript-render";

function transcriptEntry(overrides: Partial<AgentTranscriptEntry>): AgentTranscriptEntry {
  return {
    timestamp: new Date(0).toISOString(),
    source: "agent",
    phase: "streaming_turn",
    kind: "message",
    message: "message",
    ...overrides
  };
}

describe("transcript render helpers", () => {
  it("groups consecutive compact command entries into one block", () => {
    const blocks = buildTranscriptRenderBlocks([
      transcriptEntry({ kind: "message", message: "first note" }),
      transcriptEntry({ kind: "command", message: "running command: rg workpad" }),
      transcriptEntry({ kind: "command", message: "finished command: rg workpad" }),
      transcriptEntry({ kind: "status", message: "task status changed Todo -> In Progress" })
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "item" });
    expect(blocks[1]).toMatchObject({ type: "command-group" });
    if (blocks[1].type !== "command-group") {
      throw new Error("expected command-group");
    }
    expect(blocks[1].entries).toHaveLength(2);
    expect(blocks[2]).toMatchObject({ type: "item" });
  });

  it("keeps edited-file summaries as normal transcript items", () => {
    const entry = transcriptEntry({ kind: "command", message: "edited 2 files: src/app.ts, README.md" });
    expect(isCompactCommandEntry(entry)).toBe(false);
  });

  it("builds tooltips from command messages", () => {
    expect(commandTooltip(transcriptEntry({ kind: "command", message: "running command: git status --short" }))).toBe(
      "git status --short"
    );
    expect(commandTooltip(transcriptEntry({ kind: "command", message: "submitting pull request" }))).toBe(
      "submitting pull request"
    );
  });

  it("assigns tones for running, finished, and special commands", () => {
    expect(commandIconTone(transcriptEntry({ kind: "command", message: "running command: rg workpad" }))).toBe("running");
    expect(commandIconTone(transcriptEntry({ kind: "command", message: "finished command: rg workpad" }))).toBe("done");
    expect(commandIconTone(transcriptEntry({ kind: "command", message: "submitting pull request" }))).toBe("special");
  });
});
