import { describe, expect, it } from "vitest";

import { buildAutoUserInputResult, summarizeUserInputRequest } from "../src/codex-user-input";

describe("buildAutoUserInputResult", () => {
  it("auto-approves approval-style prompts when auto approval is enabled", () => {
    const result = buildAutoUserInputResult(
      {
        questions: [
          {
            id: "config_mode",
            header: "Mode",
            question: "How should the agent proceed?",
            options: [{ label: "Approve this Session" }, { label: "Deny" }]
          }
        ]
      },
      { autoApproveRequests: true }
    );

    expect(result).toEqual({
      kind: "approval_auto_approved",
      answers: {
        config_mode: {
          answers: ["Approve this Session"]
        }
      },
      summary: "Auto-approved user-input request: Mode -> Approve this Session"
    });
  });

  it("returns the Symphony-style non-interactive answer for generic prompts", () => {
    const result = buildAutoUserInputResult(
      {
        questions: [
          {
            id: "direction",
            question: "Which path should we take?",
            options: [{ label: "Retry" }, { label: "Abort" }]
          }
        ]
      },
      { autoApproveRequests: false }
    );

    expect(result).toEqual({
      kind: "user_input_auto_answered",
      answers: {
        direction: {
          answers: ["This is a non-interactive session. Operator input is unavailable."]
        }
      },
      summary:
        "Auto-answered user-input request: Which path should we take? -> This is a non-interactive session. Operator input is unavailable."
    });
  });

  it("returns null when there are no recognizable questions", () => {
    const result = buildAutoUserInputResult(
      {
        foo: "bar"
      },
      { autoApproveRequests: false }
    );

    expect(result).toBeNull();
  });

  it("summarizes the visible question when auto-answering is not possible", () => {
    expect(
      summarizeUserInputRequest({
        question: "Continue?"
      })
    ).toBe("Tool requires user input: Continue?");

    expect(
      summarizeUserInputRequest({
        questions: [
          {
            id: "notes",
            question: "Any additional instructions?"
          }
        ]
      })
    ).toContain("Any additional instructions?");
  });
});
