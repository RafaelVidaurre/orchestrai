import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AppController } from "../src/app-controller";
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
});
