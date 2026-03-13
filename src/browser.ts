import { spawn } from "node:child_process";
import os from "node:os";

export async function openUrlInBrowser(url: string): Promise<void> {
  const platform = os.platform();
  if (platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }

  if (platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }

  spawnDetached("xdg-open", [url]);
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
