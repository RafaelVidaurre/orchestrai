import { describe, expect, it, vi } from "vitest";

import { TuiController } from "../src/tui-controller";

describe("tui controller", () => {
  it("falls back to an ephemeral dashboard port when 4318 is already in use", async () => {
    const dashboardHost = {
      start: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }))
        .mockResolvedValueOnce({
          host: "127.0.0.1",
          port: 49001,
          url: "http://127.0.0.1:49001"
        }),
      stop: vi.fn()
    };

    const controller = new TuiController(
      {
        startRuntime: vi.fn(),
        stopRuntime: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
        subscribeState: vi.fn(() => () => undefined),
        snapshot: vi.fn(() => {
          throw new Error("not used");
        }),
        state: vi.fn(() => {
          throw new Error("not used");
        })
      } as never,
      dashboardHost as never
    );

    const url = await controller.startDashboard();

    expect(url).toBe("http://127.0.0.1:49001");
    expect(dashboardHost.start).toHaveBeenNthCalledWith(1, 4318, "127.0.0.1");
    expect(dashboardHost.start).toHaveBeenNthCalledWith(2, 0, "127.0.0.1");
  });
});
