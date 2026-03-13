import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDashboardAssetCandidates } from "../src/status-server";

describe("status server asset resolution", () => {
  it("finds the dashboard bundle next to the compiled dist tree", () => {
    const candidates = resolveDashboardAssetCandidates("/repo/dist/src", "/tmp/elsewhere");

    expect(candidates).toContain(path.resolve("/repo/dist/dashboard-client.browser.js"));
    expect(candidates).not.toContain(path.resolve("/repo/dist/dist/dashboard-client.browser.js"));
  });

  it("finds the dashboard bundle from the source tree during tsx execution", () => {
    const candidates = resolveDashboardAssetCandidates("/repo/src", "/tmp/elsewhere");

    expect(candidates).toContain(path.resolve("/repo/dist/dashboard-client.browser.js"));
    expect(candidates[0]).toBe(path.resolve("/repo/src/dashboard-client.browser.js"));
  });
});
