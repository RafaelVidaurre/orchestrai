#!/usr/bin/env node

import { AppController } from "./app-controller";
import { loadEnvFiles } from "./env";
import { createRootLoggerFromEnv } from "./logger";
import { resolveWorkflowContext } from "./workflow";

async function main(): Promise<void> {
  const logger = createRootLoggerFromEnv();
  const workflowContext = await resolveWorkflowContext(process.argv[2], { allowEmpty: true });
  const env = { ...process.env };
  await loadEnvFiles(workflowContext.projectsRoot, env, logger.child({ component: "global-env" }));
  const app = new AppController(workflowContext, logger, env);

  const stop = async () => {
    await app.stop().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await app.start({ runtime: true, dashboard: true });
  await new Promise(() => undefined);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
