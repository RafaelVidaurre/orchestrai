import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ServiceError } from "../src/errors";
import {
  classifyFatalRuntimeError,
  fatalProjectErrorLogPath,
  readFatalProjectError,
  recordFatalProjectError
} from "../src/fatal-runtime-errors";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fatal runtime errors", () => {
  it("classifies Grok 403 responses as fatal", () => {
    const fatal = classifyFatalRuntimeError({
      provider: "grok",
      stage: "worker",
      error: new ServiceError("grok_api_status", "Grok API returned HTTP 403: forbidden", {
        status: 403,
        detail: "forbidden"
      }),
      issue: {
        id: "issue-1",
        identifier: "ABC-123",
        title: "Handle auth failures"
      }
    });

    expect(fatal).toMatchObject({
      code: "grok_api_status",
      provider: "grok",
      issue_identifier: "ABC-123"
    });
    expect(fatal?.details).toMatchObject({ status: 403 });
  });

  it("persists the current fatal error and appends a log entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fatal-runtime-"));
    tempRoots.push(root);
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(workflowPath, "---\nproject:\n  enabled: true\n---\nnoop\n", "utf8");

    const record = await recordFatalProjectError({
      workflowPath,
      provider: "grok",
      stage: "startup",
      error: new ServiceError("missing_grok_api_key", "grok.api_key or XAI_API_KEY must be configured")
    });

    const persisted = await readFatalProjectError(workflowPath);
    const logContent = await readFile(fatalProjectErrorLogPath(workflowPath), "utf8");

    expect(persisted).toEqual(record);
    expect(logContent).toContain("missing_grok_api_key");
    expect(logContent.trim().split("\n")).toHaveLength(1);
  });
});
