import { readFile } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import path from "node:path";

import type { StatusSnapshot, StatusSource } from "./domain";
import { Logger } from "./logger";

export class StatusServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private unsubscribe: (() => void) | null = null;
  private dashboardAssetPromise: Promise<Buffer> | null = null;

  constructor(
    private readonly statusSource: StatusSource,
    private readonly logger: Logger
  ) {}

  async start(port: number, host: string): Promise<{ host: string; port: number; url: string }> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.unsubscribe = this.statusSource.subscribe((snapshot) => {
      this.broadcastSnapshot(snapshot);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => {
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve dashboard server address");
    }

    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
    this.logger.info("status server started", {
      host,
      port: address.port,
      url
    });
    return {
      host,
      port: address.port,
      url
    };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderDashboardHtml(this.statusSource.snapshot()));
      return;
    }

    if (request.method === "GET" && url.pathname === "/assets/dashboard.js") {
      await this.serveDashboardAsset(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(this.statusSource.snapshot()));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive"
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(this.statusSource.snapshot())}\n\n`);
      this.clients.add(response);
      request.on("close", () => {
        this.clients.delete(response);
      });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }

  private async serveDashboardAsset(response: http.ServerResponse): Promise<void> {
    try {
      const asset = await this.getDashboardAsset();
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache"
      });
      response.end(asset);
    } catch (error) {
      this.logger.error("failed to load dashboard bundle", {
        error: error instanceof Error ? error.message : String(error)
      });
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Dashboard bundle not found. Run `yarn dashboard:build` or `yarn build`.");
    }
  }

  private async getDashboardAsset(): Promise<Buffer> {
    if (!this.dashboardAssetPromise) {
      this.dashboardAssetPromise = readDashboardAsset().catch((error) => {
        this.dashboardAssetPromise = null;
        throw error;
      });
    }

    return this.dashboardAssetPromise;
  }

  private broadcastSnapshot(snapshot: StatusSnapshot): void {
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }
}

async function readDashboardAsset(): Promise<Buffer> {
  const candidates = [
    path.resolve(__dirname, "dashboard-client.browser.js"),
    path.resolve(__dirname, "../dist/dashboard-client.browser.js"),
    path.resolve(process.cwd(), "dist/dashboard-client.browser.js")
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error("dashboard bundle missing");
}

function renderDashboardHtml(snapshot: StatusSnapshot): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Symphony Dashboard</title>
    <style>${renderDashboardStyles()}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>
      window.__SYMPHONY_INITIAL_SNAPSHOT__ = ${serializeForInlineScript(snapshot)};
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

function renderDashboardStyles(): string {
  return `
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --bg-top: #fbf7f0;
      --panel: rgba(255, 251, 245, 0.88);
      --panel-strong: #fffaf2;
      --ink: #192126;
      --muted: #59656d;
      --line: rgba(25, 33, 38, 0.12);
      --card-line: rgba(25, 33, 38, 0.08);
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.12);
      --warn: #b45309;
      --warn-soft: rgba(180, 83, 9, 0.12);
      --error: #b91c1c;
      --activity-from: rgba(15, 118, 110, 0.1);
      --activity-to: rgba(15, 118, 110, 0.03);
      --empty-bg: rgba(255, 255, 255, 0.38);
      --shadow: 0 18px 50px rgba(31, 41, 55, 0.1);
      --hero-accent: rgba(15, 118, 110, 0.16);
      --hero-warn: rgba(180, 83, 9, 0.12);
      --project-pill-bg: rgba(59, 130, 246, 0.12);
      --project-pill-ink: #2563eb;
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --bg: #081219;
        --bg-top: #0d1820;
        --panel: rgba(10, 23, 30, 0.82);
        --panel-strong: #0f1d25;
        --ink: #edf6f2;
        --muted: #8ea6a3;
        --line: rgba(195, 224, 217, 0.12);
        --card-line: rgba(195, 224, 217, 0.08);
        --accent: #4fd1c5;
        --accent-soft: rgba(79, 209, 197, 0.16);
        --warn: #fbbf24;
        --warn-soft: rgba(251, 191, 36, 0.16);
        --error: #f87171;
        --activity-from: rgba(79, 209, 197, 0.16);
        --activity-to: rgba(79, 209, 197, 0.04);
        --empty-bg: rgba(6, 16, 21, 0.62);
        --shadow: 0 20px 64px rgba(0, 0, 0, 0.34);
        --hero-accent: rgba(79, 209, 197, 0.18);
        --hero-warn: rgba(251, 191, 36, 0.1);
        --project-pill-bg: rgba(96, 165, 250, 0.18);
        --project-pill-ink: #93c5fd;
      }
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #081219;
      --bg-top: #0d1820;
      --panel: rgba(10, 23, 30, 0.82);
      --panel-strong: #0f1d25;
      --ink: #edf6f2;
      --muted: #8ea6a3;
      --line: rgba(195, 224, 217, 0.12);
      --card-line: rgba(195, 224, 217, 0.08);
      --accent: #4fd1c5;
      --accent-soft: rgba(79, 209, 197, 0.16);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.16);
      --error: #f87171;
      --activity-from: rgba(79, 209, 197, 0.16);
      --activity-to: rgba(79, 209, 197, 0.04);
      --empty-bg: rgba(6, 16, 21, 0.62);
      --shadow: 0 20px 64px rgba(0, 0, 0, 0.34);
      --hero-accent: rgba(79, 209, 197, 0.18);
      --hero-warn: rgba(251, 191, 36, 0.1);
      --project-pill-bg: rgba(96, 165, 250, 0.18);
      --project-pill-ink: #93c5fd;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body,
    #app {
      min-height: 100%;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, var(--hero-accent), transparent 30%),
        radial-gradient(circle at top right, var(--hero-warn), transparent 24%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg) 100%);
    }

    a {
      color: inherit;
    }

    main {
      width: min(1360px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 36px;
    }

    .hero {
      display: flex;
      gap: 20px;
      align-items: end;
      justify-content: space-between;
      margin-bottom: 22px;
    }

    .hero h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.2rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }

    .hero p {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 760px;
    }

    .hero-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .theme-field,
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      border-radius: 999px;
      padding: 10px 14px;
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }

    .theme-field span {
      color: var(--muted);
      font-size: 0.9rem;
    }

    .theme-select {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      background: var(--panel-strong);
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--accent);
      animation: pulse 1.8s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.4); opacity: 0.45; }
    }

    .dashboard-body,
    .sidebar-panels,
    .metrics,
    .layout,
    .project-list,
    .agent-list,
    .retry-list,
    .event-list,
    .project-meta,
    .fact-list,
    .rate-limit-columns {
      display: grid;
      gap: 12px;
    }

    .dashboard-body {
      gap: 18px;
    }

    .metrics {
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
    }

    .layout {
      grid-template-columns: 2fr 1fr;
      gap: 16px;
    }

    .project-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .rate-limit-columns {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 12px;
    }

    .metric,
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .metric {
      padding: 18px 20px;
    }

    .metric .label {
      display: block;
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.09em;
    }

    .metric .value {
      display: block;
      margin-top: 10px;
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.04em;
    }

    .panel {
      padding: 18px;
    }

    .panel h2 {
      margin: 0 0 14px;
      font-size: 1.05rem;
      letter-spacing: -0.02em;
    }

    .project-card,
    .agent-card,
    .retry-card,
    .event-item {
      background: var(--panel-strong);
      border: 1px solid var(--card-line);
      border-radius: 18px;
      padding: 14px;
    }

    .project-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 1.05rem;
      text-decoration: none;
    }

    .project-link:hover {
      text-decoration: underline;
    }

    .project-meta,
    .fact-list {
      margin-top: 12px;
    }

    .meta-row,
    .fact-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
    }

    .fact-row strong,
    .meta-row strong {
      color: var(--ink);
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.09em;
    }

    .agent-head,
    .retry-head,
    .event-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .agent-head,
    .retry-head {
      align-items: baseline;
    }

    .ticket {
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .title,
    .muted {
      color: var(--muted);
    }

    .title {
      margin-top: 4px;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .pill {
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.82rem;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .pill.warn {
      background: var(--warn-soft);
      color: var(--warn);
    }

    .pill.project {
      background: var(--project-pill-bg);
      color: var(--project-pill-ink);
    }

    .activity {
      margin-top: 12px;
      padding: 12px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--activity-from), var(--activity-to));
    }

    .activity strong {
      display: block;
      margin-bottom: 6px;
    }

    .empty {
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 18px;
      color: var(--muted);
      background: var(--empty-bg);
    }

    .event-item {
      gap: 6px;
    }

    .event-meta {
      color: var(--muted);
      font-size: 0.84rem;
    }

    @media (max-width: 980px) {
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .layout,
      .project-list,
      .rate-limit-columns {
        grid-template-columns: 1fr;
      }

      .hero {
        flex-direction: column;
        align-items: start;
      }
    }
  `;
}
