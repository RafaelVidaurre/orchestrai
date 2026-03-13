#!/usr/bin/env node

import { createRootLoggerFromEnv } from "./logger";
import { RuntimeManager } from "./runtime";
import { StatusServer } from "./status-server";
import { resolveWorkflowPaths } from "./workflow";

async function main(): Promise<void> {
  const logger = createRootLoggerFromEnv();
  const workflowPaths = await resolveWorkflowPaths(process.argv[2]);
  const runtime = new RuntimeManager(workflowPaths, logger);

  let statusServer: StatusServer | null = null;
  const stop = async () => {
    await statusServer?.stop().catch(() => undefined);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await runtime.start();
  const dashboardConfig = runtime.dashboardConfig();
  if (dashboardConfig) {
    statusServer = new StatusServer(runtime, logger.child({ component: "status-server" }));
    await statusServer.start(dashboardConfig.port, dashboardConfig.host);
  }
  await new Promise(() => undefined);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
