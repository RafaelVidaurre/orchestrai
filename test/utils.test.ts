import { describe, expect, it } from "vitest";

import type { Issue } from "../src/domain";
import { computeRetryDelayMs, sanitizeWorkspaceKey, sortIssuesForDispatch } from "../src/utils";

describe("utils", () => {
  it("sanitizes workspace keys", () => {
    expect(sanitizeWorkspaceKey("ABC-123/hello world")).toBe("ABC-123_hello_world");
  });

  it("sorts issues by priority then age then identifier", () => {
    const issues: Issue[] = [
      baseIssue({ identifier: "ST-2", priority: 2, created_at: "2026-03-11T10:00:00.000Z" }),
      baseIssue({ identifier: "ST-1", priority: 1, created_at: "2026-03-12T10:00:00.000Z" }),
      baseIssue({ identifier: "ST-3", priority: 1, created_at: "2026-03-10T10:00:00.000Z" })
    ];

    expect(sortIssuesForDispatch(issues).map((issue) => issue.identifier)).toEqual(["ST-3", "ST-1", "ST-2"]);
  });

  it("uses the continuation retry delay for clean exits and exponential backoff for failures", () => {
    expect(computeRetryDelayMs(1, 300000, true)).toBe(1000);
    expect(computeRetryDelayMs(1, 300000, false)).toBe(10000);
    expect(computeRetryDelayMs(3, 300000, false)).toBe(40000);
  });
});

function baseIssue(overrides: Partial<Issue>): Issue {
  return {
    id: overrides.id ?? overrides.identifier ?? "id",
    identifier: overrides.identifier ?? "ISSUE-1",
    title: overrides.title ?? "Issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Todo",
    branch_name: overrides.branch_name ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blocked_by: overrides.blocked_by ?? [],
    created_at: overrides.created_at ?? null,
    updated_at: overrides.updated_at ?? null
  };
}
