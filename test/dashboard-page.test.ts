import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDashboardAssetCandidates } from "../src/dashboard-page";

describe("resolveDashboardAssetCandidates", () => {
  it("includes the bundled TUI dist asset when launched from dist/tui.mjs", () => {
    const repoRoot = "/tmp/orchestrai";
    const candidates = resolveDashboardAssetCandidates("/tmp/consumer-workspace", {
      moduleDir: null,
      entryPath: path.join(repoRoot, "dist", "tui.mjs")
    });

    expect(candidates).toContain(path.join(repoRoot, "dist", "dashboard-client.browser.js"));
  });
});
