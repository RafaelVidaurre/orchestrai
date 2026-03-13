#!/usr/bin/env node

import path from "node:path";

import { loadEnvFiles } from "./env";
import { Orchestrator } from "./orchestrator";
import { resolveWorkflowPath } from "./workflow";

async function main(): Promise<void> {
  const workflowPath = resolveWorkflowPath(process.argv[2]);
  await loadEnvFiles(path.dirname(workflowPath));
  const orchestrator = new Orchestrator(workflowPath);

  const stop = async () => {
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await orchestrator.start();
  await new Promise(() => undefined);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
