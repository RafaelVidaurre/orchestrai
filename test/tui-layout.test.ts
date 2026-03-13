import { describe, expect, it } from "vitest";

import type { OperatorEvent, StatusRetryEntry, StatusRunningEntry } from "../src/domain";
import { buildAgentTableLines, buildEventLines, buildRetryLines, compactActivity, formatElapsedShort } from "../src/tui-layout";

describe("tui layout helpers", () => {
  it("formats elapsed durations for short and long runs", () => {
    expect(formatElapsedShort(0)).toBe("0m 0s");
    expect(formatElapsedShort(65_000)).toBe("1m 5s");
    expect(formatElapsedShort(3_780_000)).toBe("1h 3m");
  });

  it("normalizes and truncates noisy activity text", () => {
    expect(compactActivity("  command   output\nstreaming   now ")).toBe("command output streaming now");
    expect(compactActivity("x".repeat(80))).toBe(`${"x".repeat(69)}...`);
  });

  it("builds an active-agent table with runtime and activity columns", () => {
    const entry: StatusRunningEntry = {
      workflow_path: "/tmp/workflows/alpha/WORKFLOW.md",
      project_slug: "alpha",
      project_name: "Alpha",
      project_url: "https://linear.app/project/alpha",
      issue_id: "issue-1",
      identifier: "MT-101",
      title: "Fix battle music loop",
      state: "In Progress",
      priority: 2,
      attempt: 1,
      session_id: "session-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      codex_app_server_pid: 1234,
      phase: "streaming_turn",
      activity: "Investigating runtime desync in the audio playback pipeline",
      last_event: "turn_completed",
      last_message: "updated plan",
      last_timestamp_ms: 60_000,
      started_at_ms: 0,
      turn_count: 2,
      codex_input_tokens: 1200,
      codex_output_tokens: 340,
      codex_total_tokens: 1540,
      issue_url: "https://linear.app/issue/MT-101",
      recent_activity: [
        {
          timestamp: new Date(60_000).toISOString(),
          source: "worker",
          phase: "streaming_turn",
          message: "Investigating runtime desync in the audio playback pipeline"
        }
      ],
      transcript_activity: []
    };

    const lines = buildAgentTableLines([entry], 112, 65_000);

    expect(lines[0]).toContain("ACTIVITY");
    expect(lines[1]).toContain("MT-101");
    expect(lines[1]).toContain("Alpha");
    expect(lines[1]).toContain("1m 5s");
    expect(lines[1]).toContain("working");
    expect(lines[1]).toContain("Investigating runtime desync");
  });

  it("builds a retry table ordered around due time", () => {
    const entry: StatusRetryEntry = {
      workflow_path: "/tmp/workflows/alpha/WORKFLOW.md",
      project_slug: "alpha",
      project_name: "Alpha",
      project_url: "https://linear.app/project/alpha",
      issue_id: "issue-2",
      identifier: "MT-202",
      title: "Retry stuck PR reconciliation",
      attempt: 3,
      due_at_ms: 75_000,
      error: "awaiting retry window"
    };

    const lines = buildRetryLines([entry], 96, 65_000);

    expect(lines[0]).toContain("DUE");
    expect(lines[1]).toContain("MT-202");
    expect(lines[1]).toContain("0m 10s");
    expect(lines[1]).toContain("Retry stuck PR reconciliation");
  });

  it("builds an operator event table for recent activity", () => {
    const event: OperatorEvent = {
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      level: "info",
      message: "worker activity",
      issueId: "issue-1",
      issueIdentifier: "MT-101",
      fields: {
        activity: "Turn 1 finished; issue moved Todo -> In Progress"
      }
    };

    const lines = buildEventLines([event], 100);

    expect(lines[0]).toContain("EVENT");
    expect(lines[1]).toContain("MT-101");
    expect(lines[1]).toContain("issue moved Todo -> In Progress");
  });
});
