import { readFile } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import path from "node:path";

import type {
  DashboardBootstrap,
  DashboardSetupContext,
  GlobalConfigInput,
  GlobalConfigRecord,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  StatusSnapshot,
  StatusSource
} from "./domain";
import { ServiceError } from "./errors";
import { validateGlobalConfigInput } from "./global-config";
import { Logger } from "./logger";

export interface DashboardProjectSetupService {
  dashboardSetupContext(): Promise<DashboardSetupContext>;
  readGlobalConfig(): Promise<GlobalConfigRecord>;
  updateGlobalConfig(input: GlobalConfigInput): Promise<GlobalConfigRecord>;
  listProjects(): Promise<ManagedProjectRecord[]>;
  createProject(input: ProjectSetupInput): Promise<ProjectSetupResult>;
  updateProject(input: ProjectUpdateInput): Promise<ManagedProjectRecord>;
  startProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord>;
  stopProject(input: ProjectRuntimeControlInput): Promise<ManagedProjectRecord>;
  removeProject(id: string): Promise<void>;
}

export class StatusServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private unsubscribe: (() => void) | null = null;
  private dashboardAssetPromise: Promise<Buffer> | null = null;

  constructor(
    private readonly statusSource: StatusSource,
    private readonly logger: Logger,
    private readonly projectSetupService?: DashboardProjectSetupService
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
      const setupContext = this.projectSetupService
        ? await this.projectSetupService.dashboardSetupContext()
        : defaultSetupContext();
      response.end(
        renderDashboardHtml({
          initialSnapshot: this.statusSource.snapshot(),
          setupContext
        })
      );
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

    if (request.method === "GET" && url.pathname === "/api/setup/context") {
      await this.handleSetupContext(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings/global") {
      await this.handleReadGlobalConfig(response);
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/api/settings/global") {
      await this.handleUpdateGlobalConfig(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      await this.handleListProjects(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      await this.handleCreateProject(request, response);
      return;
    }

    if (request.method === "PATCH" && url.pathname === "/api/projects") {
      await this.handleUpdateProject(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects/start") {
      await this.handleStartProject(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects/stop") {
      await this.handleStopProject(request, response);
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/projects") {
      await this.handleDeleteProject(request, response);
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

  private async handleListProjects(response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end("[]");
      return;
    }

    try {
      const projects = await this.projectSetupService.listProjects();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(projects));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to list projects" }));
    }
  }

  private async handleSetupContext(response: http.ServerResponse): Promise<void> {
    const setupContext = this.projectSetupService
      ? await this.projectSetupService.dashboardSetupContext()
      : defaultSetupContext();
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(setupContext));
  }

  private async handleReadGlobalConfig(response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(defaultSetupContext().globalConfig));
      return;
    }

    try {
      const globalConfig = await this.projectSetupService.readGlobalConfig();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(globalConfig));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to read global config" }));
    }
  }

  private async handleUpdateGlobalConfig(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const globalConfig = await this.projectSetupService.updateGlobalConfig(validateGlobalConfigInput(body));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(globalConfig));
    } catch (error) {
      const statusCode = error instanceof ServiceError && error.code === "invalid_project_setup" ? 400 : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to update global config" }));
    }
  }

  private async handleCreateProject(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await this.projectSetupService.createProject(validateProjectSetupInput(body));
      response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const statusCode =
        error instanceof ServiceError &&
        ["invalid_project_setup", "invalid_github_repository", "workflow_exists"].includes(error.code)
          ? 400
          : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Failed to create project"
        })
      );
    }
  }

  private async handleUpdateProject(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await this.projectSetupService.updateProject(validateProjectUpdateInput(body));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const statusCode =
        error instanceof ServiceError &&
        ["invalid_project_setup", "invalid_github_repository", "workflow_exists", "missing_workflow_file"].includes(error.code)
          ? 400
          : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to update project" }));
    }
  }

  private async handleDeleteProject(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const { id } = validateProjectDeleteInput(body);
      await this.projectSetupService.removeProject(id);
      response.writeHead(204);
      response.end();
    } catch (error) {
      const statusCode = error instanceof ServiceError && error.code === "invalid_project_setup" ? 400 : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to delete project" }));
    }
  }

  private async handleStartProject(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await this.projectSetupService.startProject(validateProjectRuntimeControlInput(body));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const statusCode = error instanceof ServiceError && error.code === "invalid_project_setup" ? 400 : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to start project" }));
    }
  }

  private async handleStopProject(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.projectSetupService) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Project setup is not available in this runtime." }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await this.projectSetupService.stopProject(validateProjectRuntimeControlInput(body));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      const statusCode = error instanceof ServiceError && error.code === "invalid_project_setup" ? 400 : 500;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Failed to stop project" }));
    }
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
  const candidates = resolveDashboardAssetCandidates(resolveRuntimeBaseDir(), process.cwd());

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

export function resolveDashboardAssetCandidates(baseDir: string, cwd: string): string[] {
  const normalizedBaseDir = path.resolve(baseDir);
  const baseName = path.basename(normalizedBaseDir);
  const parentName = path.basename(path.dirname(normalizedBaseDir));

  return uniquePaths([
    path.resolve(normalizedBaseDir, "dashboard-client.browser.js"),
    ...(baseName === "src" && parentName === "dist"
      ? [path.resolve(normalizedBaseDir, "../dashboard-client.browser.js")]
      : []),
    ...(baseName === "src" && parentName !== "dist"
      ? [path.resolve(normalizedBaseDir, "../dist/dashboard-client.browser.js")]
      : []),
    path.resolve(cwd, "dist/dashboard-client.browser.js")
  ]);
}

function resolveRuntimeBaseDir(): string {
  if (typeof __dirname === "string" && __dirname.length > 0) {
    return __dirname;
  }

  const entryPath = process.argv[1];
  if (typeof entryPath === "string" && /\.(?:[cm]?[jt]s|tsx?)$/i.test(entryPath)) {
    return path.dirname(path.resolve(entryPath));
  }

  return process.cwd();
}

function renderDashboardHtml(bootstrap: DashboardBootstrap): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>OrchestrAI Dashboard</title>
    <style>${renderDashboardStyles()}</style>
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

function uniquePaths(values: string[]): string[] {
  return [...new Set(values)];
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

    .app-shell {
      width: min(1480px, calc(100vw - 24px));
      margin: 0 auto;
      min-height: 100vh;
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
      gap: 18px;
      padding: 18px 0 28px;
    }

    .project-rail {
      position: sticky;
      top: 0;
      align-self: start;
      padding-top: 10px;
      display: grid;
      justify-items: center;
      gap: 14px;
    }

    .rail-stack {
      display: grid;
      gap: 14px;
      justify-items: center;
    }

    .project-pill {
      appearance: none;
      border: 0;
      background: transparent;
      padding: 0;
      position: relative;
      cursor: pointer;
      display: grid;
      place-items: center;
    }

    .project-pill-indicator {
      position: absolute;
      left: -12px;
      width: 4px;
      height: 10px;
      border-radius: 999px;
      background: var(--ink);
      opacity: 0;
      transform: scaleY(0.5);
      transition: opacity 140ms ease, transform 140ms ease, height 140ms ease;
    }

    .project-pill-face {
      width: 58px;
      height: 58px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: rgba(25, 33, 38, 0.08);
      color: var(--ink);
      font-weight: 800;
      font-size: 1.1rem;
      letter-spacing: -0.03em;
      box-shadow: var(--shadow);
      transition: transform 160ms ease, border-radius 160ms ease, background 160ms ease, color 160ms ease;
      border: 1px solid var(--line);
      backdrop-filter: blur(12px);
    }

    .project-pill-status {
      position: absolute;
      right: 7px;
      bottom: 7px;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      border: 2px solid var(--panel-strong);
      background: var(--muted);
      opacity: 0.92;
    }

    .project-pill:hover .project-pill-face,
    .project-pill.selected .project-pill-face {
      transform: translateY(-2px);
      border-radius: 22px;
      background: var(--accent);
      color: #fff;
    }

    .project-pill.running .project-pill-status {
      background: var(--accent);
    }

    .project-pill.stopped .project-pill-face {
      opacity: 0.82;
    }

    .project-pill.stopped .project-pill-status {
      background: var(--warn);
    }

    .project-pill.add .project-pill-face {
      background: var(--panel);
      color: var(--accent);
    }

    .project-pill:hover .project-pill-indicator,
    .project-pill.selected .project-pill-indicator {
      opacity: 1;
      transform: scaleY(1);
      height: 34px;
    }

    main {
      width: 100%;
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
    .setup-grid,
    .setup-card,
    .setup-form,
    .field-grid,
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

    .setup-grid {
      grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.7fr);
      margin-bottom: 18px;
      align-items: start;
    }

    .setup-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      padding: 18px;
      gap: 14px;
    }

    .setup-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
    }

    .setup-form,
    .field-grid {
      gap: 12px;
    }

    .field-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .setup-card h2,
    .setup-card h3 {
      margin: 0;
      letter-spacing: -0.02em;
    }

    .setup-card p {
      margin: 0;
      color: var(--muted);
    }

    .setup-callout {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--card-line);
      background: var(--panel-strong);
    }

    .mini-badge {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: end;
    }

    .mini-badge span {
      border-radius: 999px;
      padding: 7px 10px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.82rem;
      font-weight: 700;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field span {
      font-size: 0.88rem;
      color: var(--muted);
    }

    .field input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-strong);
      color: var(--ink);
      padding: 12px 14px;
      font: inherit;
    }

    .field input::placeholder {
      color: var(--muted);
    }

    .field.full {
      grid-column: 1 / -1;
    }

    .setup-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .toggle-row {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 0.92rem;
    }

    .primary-button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 12px 18px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }

    .secondary-button {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 12px 18px;
      background: var(--panel-strong);
      color: var(--ink);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }

    .danger-button {
      appearance: none;
      border: 1px solid rgba(185, 28, 28, 0.18);
      border-radius: 999px;
      padding: 12px 18px;
      background: rgba(185, 28, 28, 0.1);
      color: var(--error);
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }

    .primary-button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .secondary-button:disabled,
    .danger-button:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .setup-status {
      color: var(--muted);
      font-size: 0.92rem;
    }

    .setup-status.error {
      color: var(--error);
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

    .rail-footer {
      margin-top: 12px;
    }

    .project-pill.chrome .project-pill-face {
      background: var(--panel-strong);
      color: var(--ink);
    }

    .dashboard-main {
      display: grid;
      gap: 20px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
    }

    .topbar-copy h1 {
      margin: 6px 0 8px;
      font-size: clamp(2.2rem, 4vw, 3.4rem);
      line-height: 0.96;
      letter-spacing: -0.05em;
    }

    .topbar-copy p {
      margin: 0;
      color: var(--muted);
      max-width: 720px;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .icon-button {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .ghost-button {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }

    .ghost-button.icon-only {
      width: 36px;
      height: 36px;
      display: inline-grid;
      place-items: center;
      border-radius: 10px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
    }

    .hero-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .stat-card,
    .section-card,
    .sheet-content {
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }

    .stat-card {
      border-radius: 24px;
      padding: 18px 18px 16px;
    }

    .stat-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .stat-icon {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
    }

    .stat-value {
      margin-top: 12px;
      font-size: clamp(1.6rem, 2.5vw, 2.3rem);
      font-weight: 700;
      letter-spacing: -0.05em;
    }

    .stat-card p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 0.9rem;
    }

    .content-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
    }

    .section-card {
      border-radius: 24px;
      padding: 18px;
      min-width: 0;
    }

    .section-card.span-two {
      grid-column: span 2;
    }

    .section-card.span-three {
      grid-column: span 3;
    }

    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .section-head h2 {
      margin: 0;
      font-size: 1.1rem;
      letter-spacing: -0.03em;
    }

    .section-head p {
      margin: 6px 0 0;
      color: var(--muted);
      max-width: 60ch;
    }

    .table-wrap {
      overflow: auto;
      border-radius: 18px;
      border: 1px solid var(--card-line);
      background: var(--panel-strong);
    }

    .shad-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 860px;
    }

    .shad-table th,
    .shad-table td {
      text-align: left;
      padding: 14px 16px;
      border-bottom: 1px solid var(--card-line);
      vertical-align: top;
    }

    .shad-table th {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .shad-table tbody tr:hover {
      background: rgba(127, 152, 164, 0.06);
    }

    .table-primary {
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .table-primary a {
      text-decoration: none;
    }

    .table-primary a:hover {
      text-decoration: underline;
    }

    .table-secondary,
    .stack-meta,
    .field small,
    .notice {
      color: var(--muted);
    }

    .table-secondary {
      margin-top: 4px;
      line-height: 1.4;
    }

    .inline-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.82rem;
      font-weight: 700;
    }

    .stack-list {
      display: grid;
      gap: 12px;
    }

    .stack-item {
      padding: 14px;
      border-radius: 18px;
      background: var(--panel-strong);
      border: 1px solid var(--card-line);
    }

    .stack-item-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
    }

    .project-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .project-summary-card {
      padding: 16px;
      border-radius: 18px;
      background: var(--panel-strong);
      border: 1px solid var(--card-line);
      display: grid;
      gap: 14px;
    }

    .project-card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .project-card-head h3 {
      margin: 0;
      font-size: 1.02rem;
      letter-spacing: -0.02em;
    }

    .project-card-head p {
      margin: 6px 0 0;
      color: var(--muted);
      word-break: break-word;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.8rem;
      font-weight: 700;
    }

    .status-pill.live {
      background: var(--accent-soft);
      color: var(--accent);
    }

    .status-pill.idle {
      background: var(--warn-soft);
      color: var(--warn);
    }

    .summary-facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .summary-fact {
      display: grid;
      gap: 4px;
    }

    .summary-fact span {
      color: var(--muted);
      font-size: 0.84rem;
    }

    .summary-fact strong {
      letter-spacing: -0.02em;
      word-break: break-word;
    }

    .inline-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
    }

    .inline-link:hover {
      text-decoration: underline;
    }

    .sheet-overlay {
      position: fixed;
      inset: 0;
      background: rgba(8, 12, 18, 0.52);
      backdrop-filter: blur(6px);
    }

    .sheet-content {
      position: fixed;
      top: 18px;
      right: 18px;
      bottom: 18px;
      width: min(720px, calc(100vw - 24px));
      border-radius: 28px;
      padding: 18px;
      display: grid;
      gap: 16px;
      overflow: auto;
    }

    .sheet-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .sheet-title {
      margin: 0;
      font-size: 1.3rem;
      letter-spacing: -0.03em;
    }

    .sheet-description {
      margin: 6px 0 0;
      color: var(--muted);
    }

    .settings-tabs {
      display: inline-flex;
      gap: 8px;
      padding: 6px;
      border-radius: 999px;
      background: var(--panel-strong);
      border: 1px solid var(--card-line);
      width: fit-content;
    }

    .settings-tab {
      appearance: none;
      border: 0;
      background: transparent;
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
      font: inherit;
      color: var(--muted);
    }

    .settings-tab[data-state="active"] {
      background: var(--accent);
      color: #fff;
    }

    .settings-tab:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .settings-panel {
      padding-top: 8px;
    }

    .settings-section h2 {
      margin: 0;
      font-size: 1.12rem;
      letter-spacing: -0.03em;
    }

    .settings-section p {
      margin: 6px 0 0;
      color: var(--muted);
    }

    .settings-form {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }

    .toggle-stack {
      display: grid;
      gap: 10px;
    }

    .field small {
      line-height: 1.4;
    }

    .field input:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .form-footer {
      display: grid;
      gap: 12px;
    }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .notice.error {
      color: var(--error);
    }

    .empty-panel {
      padding: 18px;
      border-radius: 18px;
      border: 1px dashed var(--line);
      background: var(--empty-bg);
      color: var(--muted);
    }

    @media (max-width: 980px) {
      .app-shell {
        grid-template-columns: 1fr;
        width: min(1360px, calc(100vw - 20px));
      }

      .project-rail {
        position: static;
        grid-auto-flow: column;
        justify-content: start;
        overflow-x: auto;
        padding-bottom: 6px;
      }

      .rail-stack {
        grid-auto-flow: column;
      }

      .setup-grid,
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .hero-grid,
      .content-grid {
        grid-template-columns: 1fr;
      }

      .section-card.span-two,
      .section-card.span-three {
        grid-column: span 1;
      }

      .layout,
      .field-grid,
      .project-list,
      .rate-limit-columns,
      .project-grid,
      .summary-facts {
        grid-template-columns: 1fr;
      }

      .hero {
        flex-direction: column;
        align-items: start;
      }

      .topbar {
        flex-direction: column;
      }

      .topbar-actions {
        justify-content: flex-start;
      }

      .sheet-content {
        top: 12px;
        right: 12px;
        left: 12px;
        bottom: 12px;
        width: auto;
      }

      .setup-heading {
        flex-direction: column;
      }
    }
  `;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += nextChunk.byteLength;
    if (totalBytes > 64 * 1024) {
      throw new ServiceError("invalid_project_setup", "Request body is too large");
    }
    chunks.push(nextChunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateProjectSetupInput(value: unknown): ProjectSetupInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_project_setup", "Project setup payload must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  return {
    displayName: typeof input.displayName === "string" ? input.displayName : null,
    projectSlug: typeof input.projectSlug === "string" ? input.projectSlug : "",
    linearApiKey: typeof input.linearApiKey === "string" ? input.linearApiKey : null,
    githubRepository: typeof input.githubRepository === "string" ? input.githubRepository : "",
    githubToken: typeof input.githubToken === "string" ? input.githubToken : null,
    pollingIntervalMs: typeof input.pollingIntervalMs === "number" ? input.pollingIntervalMs : null,
    maxConcurrentAgents: typeof input.maxConcurrentAgents === "number" ? input.maxConcurrentAgents : null,
    useGlobalLinearApiKey: input.useGlobalLinearApiKey === true,
    useGlobalGithubToken: input.useGlobalGithubToken === true,
    useGlobalPollingIntervalMs: input.useGlobalPollingIntervalMs !== false,
    useGlobalMaxConcurrentAgents: input.useGlobalMaxConcurrentAgents !== false
  };
}

function validateProjectUpdateInput(value: unknown): ProjectUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_project_setup", "Project update payload must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new ServiceError("invalid_project_setup", "Project id is required");
  }
  return {
    id: input.id,
    displayName: typeof input.displayName === "string" ? input.displayName : null,
    projectSlug: typeof input.projectSlug === "string" ? input.projectSlug : "",
    githubRepository: typeof input.githubRepository === "string" ? input.githubRepository : "",
    linearApiKey: typeof input.linearApiKey === "string" ? input.linearApiKey : null,
    githubToken: typeof input.githubToken === "string" ? input.githubToken : null,
    pollingIntervalMs: typeof input.pollingIntervalMs === "number" ? input.pollingIntervalMs : null,
    maxConcurrentAgents: typeof input.maxConcurrentAgents === "number" ? input.maxConcurrentAgents : null,
    useGlobalLinearApiKey: input.useGlobalLinearApiKey === true,
    useGlobalGithubToken: input.useGlobalGithubToken === true,
    useGlobalPollingIntervalMs: input.useGlobalPollingIntervalMs === true,
    useGlobalMaxConcurrentAgents: input.useGlobalMaxConcurrentAgents === true
  };
}

function validateProjectDeleteInput(value: unknown): { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_project_setup", "Project delete payload must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new ServiceError("invalid_project_setup", "Project id is required");
  }
  return {
    id: input.id
  };
}

function validateProjectRuntimeControlInput(value: unknown): ProjectRuntimeControlInput {
  return validateProjectDeleteInput(value);
}

function defaultSetupContext(): DashboardSetupContext {
  return {
    projectsRoot: path.resolve(process.cwd(), "workflows"),
    trackerKind: "linear",
    repositoryProvider: "github",
    globalConfig: {
      projectsRoot: path.resolve(process.cwd(), "workflows"),
      envFilePath: path.resolve(process.cwd(), "workflows/.env.local"),
      defaults: {
        pollingIntervalMs: 30000,
        maxConcurrentAgents: 10
      },
      hasLinearApiKey: false,
      hasGithubToken: false
    }
  };
}
