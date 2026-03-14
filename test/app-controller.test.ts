import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AppController } from "../src/app-controller";
import { fatalProjectErrorLogPath } from "../src/fatal-runtime-errors";
import { Logger } from "../src/logger";
import type { WorkflowContext } from "../src/workflow";

describe("app controller dashboard startup", () => {
  it("falls back to an ephemeral port when the requested dashboard port is already in use", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-controller-"));
    const occupiedServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("occupied");
    });

    await new Promise<void>((resolve) => {
      occupiedServer.listen(0, "127.0.0.1", () => resolve());
    });

    const address = occupiedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to resolve occupied test port");
    }

    const context: WorkflowContext = {
      targetPath: root,
      workflowPaths: [],
      projectsRoot: root
    };

    const controller = new AppController(context, new Logger({}, { writeToStreams: false }), {
      ...process.env,
      ORCHESTRAI_DASHBOARD_PORT: String(address.port)
    });

    try {
      const url = await controller.startDashboard();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(url).not.toBe(`http://127.0.0.1:${address.port}`);
      expect(controller.state().dashboardRunning).toBe(true);
    } finally {
      await controller.stop().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses a project and writes a fatal log when startup hits a fatal Grok error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-controller-fatal-"));
    const workflowDir = path.join(root, "project-one");
    const workflowPath = path.join(workflowDir, "WORKFLOW.md");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      workflowPath,
      `---\nproject:\n  enabled: true\ntracker:\n  kind: linear\n  api_key: test-linear-key\n  project_slug: demo\nworkspace:\n  root: .orchestrai/workspaces\nruntime:\n  provider: grok\nserver:\n  port: -1\n---\nnoop\n`,
      "utf8"
    );

    const context: WorkflowContext = {
      targetPath: root,
      workflowPaths: [workflowPath],
      projectsRoot: root
    };

    const controller = new AppController(context, new Logger({}, { writeToStreams: false }), process.env);

    try {
      await controller.startRuntime();

      const projects = await controller.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        enabled: false,
        runtimeRunning: false,
        fatalError: {
          code: "missing_grok_api_key",
          stage: "startup"
        }
      });

      const snapshot = controller.snapshot();
      expect(snapshot.project_states[0]).toMatchObject({
        workflow_path: workflowPath,
        enabled: false,
        runtime_running: false,
        fatal_error: {
          code: "missing_grok_api_key"
        }
      });

      const logContent = await readFile(fatalProjectErrorLogPath(workflowPath), "utf8");
      expect(logContent).toContain("missing_grok_api_key");
      expect(logContent).toContain(workflowPath);
    } finally {
      await controller.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
