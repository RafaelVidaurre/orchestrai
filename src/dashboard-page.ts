import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DashboardBootstrap } from "./domain";
import { dashboardStyles } from "./dashboard-styles";

export async function readDashboardAsset(cwd = process.cwd()): Promise<Buffer> {
  const candidates = resolveDashboardAssetCandidates(cwd);

  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error("dashboard bundle missing");
}

export function resolveDashboardAssetCandidates(
  cwd = process.cwd(),
  options: {
    moduleDir?: string | null;
    entryPath?: string | null;
  } = {}
): string[] {
  const moduleDir = options.moduleDir ?? resolveModuleDir();
  const entryPath = options.entryPath ?? process.argv[1] ?? null;
  const entryDir = entryPath ? path.resolve(path.dirname(entryPath)) : null;
  const candidates = [
    moduleDir ? path.resolve(moduleDir, "../dashboard-client.browser.js") : null,
    moduleDir ? path.resolve(moduleDir, "../dist/dashboard-client.browser.js") : null,
    entryDir ? path.resolve(entryDir, "dashboard-client.browser.js") : null,
    entryDir ? path.resolve(entryDir, "../dashboard-client.browser.js") : null,
    path.resolve(cwd, "dist/dashboard-client.browser.js")
  ];

  return [...new Set(candidates.filter(isNonEmptyString))];
}

export function renderDashboardHtml(bootstrap: DashboardBootstrap): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OrchestrAI</title>
    <link rel="icon" href="data:," />
    <style>${dashboardStyles}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>
      window.__ORCHESTRAI_BOOTSTRAP__ = ${serializeForInlineScript(bootstrap)};
    </script>
    <script src="/assets/dashboard.js" defer></script>
  </body>
</html>`;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function resolveModuleDir(): string | null {
  return typeof __dirname === "string" ? path.resolve(__dirname) : null;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}
