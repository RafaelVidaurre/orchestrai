import { describe, expect, it } from "vitest";

import {
  classifyHumanizedCodexMessage,
  humanizeCodexMethod,
  humanizeDynamicToolEvent,
  isNarrativeTranscriptKind,
  normalizeTranscriptMessage,
  shouldCaptureHumanizedCodexTranscript,
  shouldRecordHumanizedCodexNotification,
  stitchTranscriptMessages
} from "../src/codex-humanize";

describe("codex humanization", () => {
  it("humanizes direct approval and input requests", () => {
    expect(
      humanizeCodexMethod("item/commandExecution/requestApproval", {
        method: "item/commandExecution/requestApproval",
        params: { parsedCmd: "git status --short" }
      })
    ).toBe("command approval requested (git status --short)");

    expect(
      humanizeCodexMethod("item/tool/requestUserInput", {
        method: "item/tool/requestUserInput",
        params: { question: "Continue?" }
      })
    ).toBe("tool requires user input: Continue?");
  });

  it("humanizes codex wrapper events used by operator surfaces", () => {
    expect(
      humanizeCodexMethod("codex/event/task_started", {
        method: "codex/event/task_started",
        params: { msg: { type: "task_started" } }
      })
    ).toBe("task started");

    expect(
      humanizeCodexMethod("codex/event/agent_message_delta", {
        method: "codex/event/agent_message_delta",
        params: { msg: { payload: { delta: "writing workpad reconciliation update" } } }
      })
    ).toBe("agent message streaming: writing workpad reconciliation update");
  });

  it("marks the right notifications as operator-visible", () => {
    expect(shouldRecordHumanizedCodexNotification("task started")).toBe(true);
    expect(shouldRecordHumanizedCodexNotification("agent message streaming: writing workpad reconciliation update")).toBe(false);
    expect(shouldCaptureHumanizedCodexTranscript("agent message streaming: writing workpad reconciliation update")).toBe(true);
    expect(shouldRecordHumanizedCodexNotification("thread started")).toBe(false);
  });

  it("formats dynamic tool lifecycle labels", () => {
    expect(humanizeDynamicToolEvent("dynamic tool call completed", "linear_graphql")).toBe(
      "dynamic tool call completed (linear_graphql)"
    );
    expect(classifyHumanizedCodexMessage("command output streaming")).toBe("command");
    expect(classifyHumanizedCodexMessage("reasoning update: compare retry paths")).toBe("reasoning");
  });

  it("normalizes and stitches narrative transcript fragments", () => {
    expect(normalizeTranscriptMessage("message", "agent message streaming")).toBeNull();
    expect(normalizeTranscriptMessage("message", "agent message streaming: repo")).toBe("repo");
    expect(normalizeTranscriptMessage("reasoning", "reasoning update: compare retry paths")).toBe("compare retry paths");
    expect(isNarrativeTranscriptKind("message")).toBe(true);
    expect(isNarrativeTranscriptKind("command")).toBe(false);
    expect(stitchTranscriptMessages("I found", "the repo")).toBe("I found the repo");
  });
});
