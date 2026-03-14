import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRuntimeEvent, AgentUsageSnapshot, ServiceConfig } from "./domain";
import { ServiceError } from "./errors";
import { Logger } from "./logger";

const MAX_STDOUT_LINE_BYTES = 10 * 1024 * 1024;

type CurrentTurn = {
  turnId: string;
  promptFilePath: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

export class ClaudeCliSession {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private currentTurn: CurrentTurn | null = null;
  private exitPromise: Promise<void> | null = null;
  private stopRequested = false;
  private sessionId: string = randomUUID();
  private hasStartedTurn = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly workspacePath: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly onEvent: (event: AgentRuntimeEvent) => void
  ) {}

  async start(): Promise<void> {
    return;
  }

  async runTurn(prompt: string): Promise<void> {
    if (this.child) {
      throw new ServiceError("agent_busy", "Claude turn already in progress");
    }

    const turnId = randomUUID();
    const promptFilePath = path.join(this.workspacePath, `.orchestrai-claude-prompt-${turnId}.txt`);
    await writeFile(promptFilePath, prompt, "utf8");

    const command = buildClaudeCommand({
      baseCommand: this.config.claude.command,
      model: this.config.runtime.model,
      permissionMode: this.config.claude.permissionMode,
      maxBudgetUsd: this.config.claude.maxBudgetUsd,
      promptFilePath,
      sessionId: this.sessionId,
      resume: this.hasStartedTurn
    });

    this.stopRequested = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: this.workspacePath,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.exitPromise = once(child, "exit").then(() => undefined);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      this.handleStdout(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      this.handleStderr(String(chunk));
    });
    child.on("error", (error) => {
      this.failTurn(error);
    });
    child.on("exit", (code) => {
      void rm(promptFilePath, { force: true }).catch(() => undefined);
      if (!this.stopRequested && this.currentTurn) {
        const codeName = code === 127 ? "claude_not_found" : "port_exit";
        this.failTurn(new ServiceError(codeName, "Claude CLI process exited unexpectedly", { exit_code: code }));
      }
      this.child = null;
    });

    this.emit("session_started", {
      sessionId: this.sessionId,
      threadId: this.sessionId,
      turnId
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new ServiceError("turn_timeout", "Claude turn exceeded configured timeout"));
        }, this.config.runtime.turnTimeoutMs);

        this.currentTurn = {
          turnId,
          promptFilePath,
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
      });
      this.hasStartedTurn = true;
    } finally {
      await rm(promptFilePath, { force: true }).catch(() => undefined);
      this.currentTurn = null;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;

    if (this.currentTurn) {
      const currentTurn = this.currentTurn;
      this.currentTurn = null;
      clearTimeout(currentTurn.timer);
      currentTurn.reject(new ServiceError("port_exit", "Claude CLI stopped"));
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
      this.failTurn(new ServiceError("response_error", "Claude CLI emitted an oversized stdout line"));
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

    switch (message.type) {
      case "system":
        this.handleSystemMessage(message);
        return;
      case "assistant":
        this.handleAssistantMessage(message);
        return;
      case "rate_limit_event":
        this.emit("notification", {
          message: humanizeClaudeRateLimit(message.rate_limit_info),
          rateLimits: message.rate_limit_info
        });
        return;
      case "result":
        this.handleResult(message);
        return;
      default:
        this.emit("other_message", {
          message: JSON.stringify(message)
        });
    }
  }

  private handleSystemMessage(message: Record<string, unknown>): void {
    if (typeof message.session_id === "string" && message.session_id.trim().length > 0) {
      this.sessionId = message.session_id;
    }

    if (message.subtype === "init") {
      const model = typeof message.model === "string" ? message.model : this.config.runtime.model || "default";
      this.emit("notification", {
        message: `claude initialized (${model})`
      });
    }
  }

  private handleAssistantMessage(message: Record<string, unknown>): void {
    const payload =
      message.message && typeof message.message === "object" && !Array.isArray(message.message)
        ? (message.message as Record<string, unknown>)
        : message;
    const content = Array.isArray(payload.content) ? payload.content : [];

    for (const item of content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      switch ((item as Record<string, unknown>).type) {
        case "thinking": {
          const thinkingValue = (item as Record<string, unknown>).thinking;
          const thinking = typeof thinkingValue === "string" ? thinkingValue : "";
          if (thinking.trim().length > 0) {
            this.emit("notification", {
              message: `reasoning update: ${truncateForLog(thinking)}`
            });
          }
          break;
        }
        case "tool_use": {
          const toolUse = item as Record<string, unknown>;
          this.emit("notification", {
            message: humanizeClaudeToolUse(toolUse)
          });
          break;
        }
        case "text": {
          const textValue = (item as Record<string, unknown>).text;
          const text = typeof textValue === "string" ? textValue : "";
          if (text.trim().length > 0) {
            this.emit("notification", {
              message: `assistant update: ${truncateForLog(text)}`
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private handleResult(message: Record<string, unknown>): void {
    const usage = extractClaudeUsage(message.usage);
    if (message.subtype === "success" && message.is_error !== true) {
      this.emit("turn_completed", {
        sessionId: this.sessionId,
        threadId: this.sessionId,
        turnId: this.currentTurn?.turnId,
        usage
      });
      this.completeTurn();
      return;
    }

    const subtype = typeof message.subtype === "string" ? message.subtype : "error";
    const failureMessage =
      subtype === "error_max_budget_usd"
        ? "Claude max budget reached"
        : typeof message.result === "string" && message.result.trim().length > 0
          ? truncateForLog(message.result)
          : `Claude turn failed (${subtype})`;

    this.emit("turn_failed", {
      sessionId: this.sessionId,
      threadId: this.sessionId,
      turnId: this.currentTurn?.turnId,
      usage,
      message: failureMessage
    });
    this.failTurn(new ServiceError("turn_failed", failureMessage));
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newlineIndex = this.stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.logger.warn("claude stderr", {
          workspace_path: this.workspacePath,
          line
        });
      }
      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  private failTurn(error: unknown): void {
    if (this.currentTurn) {
      const currentTurn = this.currentTurn;
      this.currentTurn = null;
      clearTimeout(currentTurn.timer);
      currentTurn.reject(error);
    }
  }

  private completeTurn(): void {
    if (this.currentTurn) {
      const currentTurn = this.currentTurn;
      this.currentTurn = null;
      clearTimeout(currentTurn.timer);
      currentTurn.resolve();
    }
  }

  private emit(
    event: AgentRuntimeEvent["event"],
    payload: Omit<AgentRuntimeEvent, "event" | "timestamp" | "provider" | "agentProcessPid">
  ): void {
    this.onEvent({
      provider: "claude",
      event,
      timestamp: new Date().toISOString(),
      agentProcessPid: this.child?.pid ?? null,
      ...payload
    });
  }
}

function buildClaudeCommand(params: {
  baseCommand: string;
  model: string;
  permissionMode: string;
  maxBudgetUsd: number | null;
  promptFilePath: string;
  sessionId: string;
  resume: boolean;
}): string {
  const baseCommand = injectClaudeModel(params.baseCommand, params.model);
  const args = [
    baseCommand,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    quoteCliValue(params.permissionMode)
  ];

  if (params.maxBudgetUsd !== null) {
    args.push("--max-budget-usd", quoteCliValue(String(params.maxBudgetUsd)));
  }

  if (params.resume) {
    args.push("--resume", quoteCliValue(params.sessionId));
  } else {
    args.push("--session-id", quoteCliValue(params.sessionId));
  }

  args.push(`"$(cat ${quoteCliValue(params.promptFilePath)})"`);
  return args.join(" ");
}

function injectClaudeModel(command: string, model: string): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return command;
  }

  const hasExplicitModel = /(^|\s)--model(\s|=)/.test(command) || /(^|\s)-m(\s|=)/.test(command);
  if (hasExplicitModel) {
    return command;
  }

  return `${command} --model ${quoteCliValue(trimmedModel)}`.trim();
}

function quoteCliValue(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function truncateForLog(value: unknown, max = 240): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 3)}...`;
}

function humanizeClaudeToolUse(toolUse: Record<string, unknown>): string {
  const name = typeof toolUse.name === "string" ? toolUse.name : "tool";
  const input =
    toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
      ? (toolUse.input as Record<string, unknown>)
      : {};

  if (name === "Bash" && typeof input.command === "string") {
    return `running command: ${truncateForLog(input.command, 180)}`;
  }

  if (name === "Read" && typeof input.file_path === "string") {
    return `reading file: ${input.file_path}`;
  }

  if ((name === "Edit" || name === "Write" || name === "MultiEdit") && typeof input.file_path === "string") {
    return `editing file: ${input.file_path}`;
  }

  if (name === "Glob" && typeof input.pattern === "string") {
    return `searching files: ${input.pattern}`;
  }

  if (name === "Grep" && typeof input.pattern === "string") {
    return `searching text: ${input.pattern}`;
  }

  return `using tool: ${name}`;
}

function humanizeClaudeRateLimit(rateLimitInfo: unknown): string {
  if (!rateLimitInfo || typeof rateLimitInfo !== "object" || Array.isArray(rateLimitInfo)) {
    return "claude rate limit updated";
  }

  const status = typeof (rateLimitInfo as Record<string, unknown>).status === "string" ? (rateLimitInfo as Record<string, unknown>).status : "unknown";
  const rateLimitType =
    typeof (rateLimitInfo as Record<string, unknown>).rateLimitType === "string"
      ? (rateLimitInfo as Record<string, unknown>).rateLimitType
      : "unknown";
  return `claude rate limit: ${status} (${rateLimitType})`;
}

function extractClaudeUsage(usage: unknown): AgentUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }

  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = coerceNumber(usageRecord.input_tokens);
  const outputTokens = coerceNumber(usageRecord.output_tokens);
  const cacheReadTokens = coerceNumber(usageRecord.cache_read_input_tokens);
  const cacheCreationTokens = coerceNumber(usageRecord.cache_creation_input_tokens);

  return {
    input_tokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
  };
}

function coerceNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
