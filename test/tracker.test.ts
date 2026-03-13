import { describe, expect, it } from "vitest";

import { parseLinearRateLimits } from "../src/tracker";

describe("parseLinearRateLimits", () => {
  it("parses Linear quota headers into dashboard-friendly fields", () => {
    const headers = new Headers({
      "x-ratelimit-requests-limit": "5000",
      "x-ratelimit-requests-remaining": "4988",
      "x-ratelimit-requests-reset": "1710000000",
      "x-ratelimit-complexity-limit": "3000000",
      "x-ratelimit-complexity-remaining": "2998200",
      "x-ratelimit-endpoint-name": "issues",
      "x-ratelimit-endpoint-requests-limit": "120",
      "x-ratelimit-endpoint-requests-remaining": "118",
      "x-complexity": "1800"
    });

    const parsed = parseLinearRateLimits(headers, Date.UTC(2026, 2, 13, 0, 0, 0));

    expect(parsed).toMatchObject({
      auth_mode: "api_key",
      requests: {
        limit: 5000,
        remaining: 4988,
        reset_at_ms: 1710000000 * 1000
      },
      complexity: {
        limit: 3000000,
        remaining: 2998200
      },
      endpoint_requests: {
        name: "issues",
        limit: 120,
        remaining: 118
      },
      last_query_complexity: 1800
    });
  });

  it("returns null when no rate-limit headers are present", () => {
    expect(parseLinearRateLimits(new Headers())).toBeNull();
  });
});
