import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ServiceError } from "../src/errors";
import type { Issue } from "../src/domain";
import { parseWorkflowFile, renderPrompt, resolveWorkflowPaths } from "../src/workflow";

describe("workflow parsing", () => {
  it("parses front matter and markdown body", () => {
    const workflow = parseWorkflowFile(`---
tracker:
  kind: linear
---
Hello {{ issue.identifier }}`);

    expect(workflow.config).toMatchObject({
      tracker: {
        kind: "linear"
      }
    });
    expect(workflow.prompt_template).toBe("Hello {{ issue.identifier }}");
  });

  it("fails prompt rendering on unknown variables", async () => {
    const workflow = parseWorkflowFile("Hello {{ issue.unknown_field }}");

    await expect(renderPrompt(workflow, issueFixture(), null)).rejects.toBeInstanceOf(ServiceError);
  });

  it("discovers multiple workflow files from a directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-discovery-"));
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await writeFile(path.join(root, "alpha.workflow.md"), "Hello");
      await writeFile(path.join(root, "nested", "WORKFLOW.md"), "World");

      await expect(resolveWorkflowPaths(root)).resolves.toEqual([
        path.join(root, "alpha.workflow.md"),
        path.join(root, "nested", "WORKFLOW.md")
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function issueFixture(): Issue {
  return {
    id: "1",
    identifier: "ST-1",
    title: "Issue",
    description: null,
    priority: 1,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
