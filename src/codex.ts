import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type { CodexRuntimeEvent, ServiceConfig } from "./domain";
import { ServiceError } from "./errors";
import { executeLinearGraphqlTool } from "./linear-tool";
import { Logger } from "./logger";

const MAX_STDOUT_LINE_BYTES = 10 * 1024 * 1024;

type JsonRpcResponse = {
  id: number | string;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

type CurrentTurn = {
  threadId: string;
  turnId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private requestId = 0;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private currentTurn: CurrentTurn | null = null;
  private exitPromise: Promise<void> | null = null;
  private stopRequested = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly workspacePath: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly onEvent: (event: CodexRuntimeEvent) => void
  ) {}

  async start(): Promise<{ threadId: string; pid: number | null }> {
    this.child = spawn("bash", ["-lc", this.config.codex.command], {
      cwd: this.workspacePath,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.exitPromise = once(this.child, "exit").then(() => undefined);

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.handleStdout(String(chunk));
    });
    this.child.stderr.on("data", (chunk) => {
      this.handleStderr(String(chunk));
    });
    this.child.on("error", (error) => {
      this.failAll(error);
    });
    this.child.on("exit", (code) => {
      if (!this.stopRequested) {
        const startupCode =
          code === 127 && this.requestId <= 2
            ? "codex_not_found"
            : "port_exit";
        this.failAll(new ServiceError(startupCode, "Codex app-server process exited unexpectedly", { exit_code: code }));
      }
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "symphony",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      });
      this.notify("initialized", {});
      await this.ensureLinearMcpAvailable();

      const threadStart = (await this.request("thread/start", {
        cwd: this.workspacePath,
        approvalPolicy: this.config.codex.approvalPolicy,
        sandbox: this.config.codex.threadSandbox,
        experimentalRawEvents: false,
        persistExtendedHistory: false
      })) as { thread?: { id?: string } };

      const threadId = threadStart.thread?.id;
      if (!threadId) {
        throw new ServiceError("response_error", "thread/start did not return a thread id");
      }

      return {
        threadId,
        pid: this.child.pid ?? null
      };
    } catch (error) {
      this.emit("startup_failed", {
        message: error instanceof Error ? error.message : "startup failed"
      });
      await this.stop();
      throw error;
    }
  }

  private async ensureLinearMcpAvailable(): Promise<void> {
    const response = (await this.request("mcpServerStatus/list", {
      limit: 100
    })) as { data?: Array<{ name?: string; authStatus?: string }> };

    const servers = response.data ?? [];
    const linearServer = servers.find((server) => (server.name ?? "").toLowerCase().includes("linear"));
    if (!linearServer) {
      throw new ServiceError("missing_linear_mcp", "Linear MCP is required but no Linear MCP server is configured in Codex");
    }

    if (!["bearerToken", "oAuth"].includes(linearServer.authStatus ?? "")) {
      throw new ServiceError(
        "linear_mcp_not_ready",
        `Linear MCP is present but not authenticated (status: ${linearServer.authStatus ?? "unknown"})`
      );
    }

    this.emit("notification", {
      message: `linear_mcp_ready:${linearServer.name}`
    });
  }

  async runTurn(threadId: string, prompt: string): Promise<{ threadId: string; turnId: string }> {
    const result = (await this.request("turn/start", {
      threadId,
      cwd: this.workspacePath,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandboxPolicy: resolveTurnSandboxPolicy(this.config, this.workspacePath),
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: []
        }
      ]
    })) as { turn?: { id?: string } };

    const turnId = result.turn?.id;
    if (!turnId) {
      throw new ServiceError("response_error", "turn/start did not return a turn id");
    }

    this.emit("session_started", {
      threadId,
      turnId,
      sessionId: `${threadId}-${turnId}`
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ServiceError("turn_timeout", "Codex turn exceeded configured timeout"));
      }, this.config.codex.turnTimeoutMs);

      this.currentTurn = {
        threadId,
        turnId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer
      };
    }).finally(() => {
      this.currentTurn = null;
    });

    return { threadId, turnId };
  }

  async stop(): Promise<void> {
    this.stopRequested = true;

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new ServiceError("port_exit", "Codex app-server stopped"));
      this.pendingRequests.delete(id);
    }

    if (this.currentTurn) {
      clearTimeout(this.currentTurn.timer);
      this.currentTurn.reject(new ServiceError("port_exit", "Codex app-server stopped"));
      this.currentTurn = null;
    }

    if (!this.child) {
      return;
    }

    if (!this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 1000).unref();
    }

    await this.exitPromise;
    this.child = null;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_STDOUT_LINE_BYTES) {
      this.failAll(new ServiceError("response_error", "Codex app-server emitted an oversized stdout line"));
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("malformed", {
        message: line
      });
      return;
    }

    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message);
      return;
    }

    if ("method" in message) {
      this.handleNotification(message);
      return;
    }

    if ("id" in message) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    this.emit("other_message", {
      message: JSON.stringify(message)
    });
  }

  private handleNotification(message: Record<string, unknown>): void {
    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } | undefined;
        if (usage?.total) {
          this.emit("notification", {
            message: method,
            threadId: asOptionalString(params.threadId),
            turnId: asOptionalString(params.turnId),
            usage: {
              input_tokens: usage.total.inputTokens ?? 0,
              output_tokens: usage.total.outputTokens ?? 0,
              total_tokens: usage.total.totalTokens ?? 0
            }
          });
        }
        return;
      }
      case "account/rateLimits/updated": {
        this.emit("notification", {
          message: method,
          rateLimits: params.rateLimits
        });
        return;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } | null };
        if (!this.currentTurn || turn.id !== this.currentTurn.turnId) {
          return;
        }

        if (turn.status === "completed") {
          this.emit("turn_completed", {
            threadId: this.currentTurn.threadId,
            turnId: this.currentTurn.turnId,
            sessionId: `${this.currentTurn.threadId}-${this.currentTurn.turnId}`
          });
          this.currentTurn.resolve();
          return;
        }

        if (turn.status === "interrupted") {
          this.emit("turn_cancelled", {
            threadId: this.currentTurn.threadId,
            turnId: this.currentTurn.turnId,
            sessionId: `${this.currentTurn.threadId}-${this.currentTurn.turnId}`
          });
          this.currentTurn.reject(new ServiceError("turn_cancelled", "Codex turn was interrupted"));
          return;
        }

        this.emit("turn_failed", {
          threadId: this.currentTurn.threadId,
          turnId: this.currentTurn.turnId,
          sessionId: `${this.currentTurn.threadId}-${this.currentTurn.turnId}`,
          message: turn.error?.message ?? "Codex turn failed"
        });
        this.currentTurn.reject(new ServiceError("turn_failed", turn.error?.message ?? "Codex turn failed"));
        return;
      }
      default: {
        this.emit("notification", {
          message: method,
          threadId: asOptionalString(params.threadId),
          turnId: asOptionalString(params.turnId)
        });
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(
        new ServiceError("response_error", response.error.message ?? "Codex app-server returned an error response")
      );
      return;
    }

    pending.resolve(response.result);
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as number | string;
    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "item/commandExecution/requestApproval":
        this.emit("approval_auto_approved", {
          message: method
        });
        this.send({
          id,
          result: {
            decision: "acceptForSession"
          }
        });
        return;
      case "item/fileChange/requestApproval":
        this.emit("approval_auto_approved", {
          message: method
        });
        this.send({
          id,
          result: {
            decision: "acceptForSession"
          }
        });
        return;
      case "applyPatchApproval":
      case "execCommandApproval":
        this.emit("approval_auto_approved", {
          message: method
        });
        this.send({
          id,
          result: {
            decision: "approved_for_session"
          }
        });
        return;
      case "item/tool/requestUserInput": {
        const threadId = asOptionalString(params.threadId);
        const turnId = asOptionalString(params.turnId);
        this.emit("turn_input_required", {
          message: method,
          threadId,
          turnId,
          sessionId: threadId && turnId ? `${threadId}-${turnId}` : undefined
        });
        this.send({
          id,
          result: {
            answers: {}
          }
        });
        if (threadId && turnId) {
          void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        }
        if (this.currentTurn) {
          this.currentTurn.reject(new ServiceError("turn_input_required", "Codex requested user input"));
        }
        return;
      }
      case "mcpServer/elicitation/request":
        this.send({
          id,
          result: {
            action: "decline",
            content: null
          }
        });
        return;
      case "item/tool/call":
        await this.handleDynamicToolCall(id, params);
        return;
      default:
        this.send({
          id,
          result: {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: `unsupported_server_request:${method}`
              }
            ]
          }
        });
    }
  }

  private async handleDynamicToolCall(id: number | string, params: Record<string, unknown>): Promise<void> {
    const tool = String(params.tool ?? "unknown");

    if (tool === "linear_graphql") {
      try {
        const result = await executeLinearGraphqlTool(this.config, params.arguments);
        this.send({
          id,
          result: {
            success: result.success,
            contentItems: [
              {
                type: "inputText",
                text: result.text
              }
            ]
          }
        });
      } catch (error) {
        this.send({
          id,
          result: {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(
                  {
                    success: false,
                    error: error instanceof Error ? error.message : "linear_graphql failed"
                  },
                  null,
                  2
                )
              }
            ]
          }
        });
      }
      return;
    }

    this.emit("unsupported_tool_call", {
      message: tool
    });
    this.send({
      id,
      result: {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "unsupported_tool_call"
          }
        ]
      }
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ServiceError("response_timeout", `Timed out waiting for ${method} response`));
      }, this.config.codex.readTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({
        id,
        method,
        params
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({
      method,
      params
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      throw new ServiceError("port_exit", "Codex app-server stdin is not writable");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newlineIndex = this.stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.logger.warn("codex stderr", {
          workspace_path: this.workspacePath,
          line
        });
      }
      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  private failAll(error: unknown): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    if (this.currentTurn) {
      clearTimeout(this.currentTurn.timer);
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
  }

  private emit(
    event: CodexRuntimeEvent["event"],
    payload: Omit<CodexRuntimeEvent, "event" | "timestamp" | "codexAppServerPid">
  ): void {
    this.onEvent({
      event,
      timestamp: new Date().toISOString(),
      codexAppServerPid: this.child?.pid ?? null,
      ...payload
    });
  }
}

function resolveTurnSandboxPolicy(config: ServiceConfig, workspacePath: string): unknown {
  if (config.codex.turnSandboxPolicy) {
    return config.codex.turnSandboxPolicy;
  }

  if (config.codex.threadSandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (config.codex.threadSandbox === "read-only") {
    return {
      type: "readOnly",
      access: {
        type: "fullAccess"
      },
      networkAccess: true
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [workspacePath],
    readOnlyAccess: {
      type: "fullAccess"
    },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
