import type { StatusSnapshot } from "./domain";
import { ControlPlaneService, type ControlPlaneState } from "./control-plane";
import { DashboardServerHost } from "./platform-module";

export class TuiController {
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly dashboardHost: DashboardServerHost
  ) {}

  async start(options: { runtime?: boolean; dashboard?: boolean } = {}): Promise<void> {
    if (options.runtime ?? true) {
      await this.startRuntime();
    }
    if (options.dashboard ?? true) {
      await this.startDashboard();
    }
  }

  async stop(): Promise<void> {
    await this.stopDashboard();
    await this.stopRuntime();
  }

  async startRuntime(): Promise<void> {
    await this.controlPlane.startRuntime();
  }

  async stopRuntime(): Promise<void> {
    await this.controlPlane.stopRuntime();
  }

  async startDashboard(): Promise<string> {
    const host = "127.0.0.1";
    const preferredPort = 4318;

    try {
      const info = await this.dashboardHost.start(preferredPort, host);
      return info.url;
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }

      const info = await this.dashboardHost.start(0, host);
      return info.url;
    }
  }

  async stopDashboard(): Promise<void> {
    await this.dashboardHost.stop();
  }

  snapshot(): StatusSnapshot {
    return this.controlPlane.snapshot();
  }

  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void {
    return this.controlPlane.subscribe(listener);
  }

  subscribeState(listener: (state: ControlPlaneState) => void): () => void {
    return this.controlPlane.subscribeState(listener);
  }

  state(): ControlPlaneState {
    return this.controlPlane.state();
  }
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}
