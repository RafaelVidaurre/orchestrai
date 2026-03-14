#!/usr/bin/env node

import { startTui } from "./tui";

void startTui(process.argv[2]).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
