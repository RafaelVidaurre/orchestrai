import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRuntimeEvent, AgentUsageSnapshot, ServiceConfig } from "./domain";
import { ServiceError, errorMessage } from "./errors";
import {
  executeLinearGraphqlTool,
  LINEAR_GRAPHQL_TOOL_NAME,
  linearGraphqlToolSpec
} from "./linear-tool";
import { Logger } from "./logger";

const DEFAULT_READ_LINE_COUNT = 200;
const MAX_READ_LINE_COUNT = 1000;
const MAX_TOOL_PATH_LENGTH = 4096;

type CurrentTurn = {
  turnId: string;
  abortController: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

type GrokResponse = {
  id?: string;
  status?: string;
  error?: {
    message?: string;
  };
  output?: unknown[];
  output_text?: string;
  usage?: unknown;
};

type GrokFunctionCall = {
  id: string;
  name: string;
  argumentsText: string;
};

type ToolExecutionResult = {
  output: string;
};

export class GrokApiSession {
  private currentTurn: CurrentTurn | null = null;
  private stopRequested = false;
  private readonly sessionId = randomUUID();
  private previousResponseId: string | null = null;

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
    if (this.currentTurn) {
      throw new ServiceError("agent_busy", "Grok turn already in progress");
    }

    const turnId = randomUUID();
    this.stopRequested = false;
    this.emit("session_started", {
      sessionId: this.sessionId,
      threadId: this.sessionId,
      turnId
    });

    await new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort();
        reject(new ServiceError("turn_timeout", "Grok turn exceeded configured timeout"));
      }, this.config.runtime.turnTimeoutMs);

      this.currentTurn = {
        turnId,
        abortController,
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

      void this.executeTurn(prompt, turnId, abortController.signal)
        .then(() => this.completeTurn())
        .catch((error) => this.failTurn(error));
    }).finally(() => {
      this.currentTurn = null;
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;

    if (!this.currentTurn) {
      return;
    }

    const currentTurn = this.currentTurn;
    this.currentTurn = null;
    clearTimeout(currentTurn.timer);
    currentTurn.abortController.abort();
    currentTurn.reject(new ServiceError("port_exit", "Grok session stopped"));
  }

  private async executeTurn(prompt: string, turnId: string, signal: AbortSignal): Promise<void> {
    let input: string | Array<Record<string, unknown>> = prompt;
    let responseId = this.previousResponseId;
    let toolRoundCount = 0;
    let lastUsage: AgentUsageSnapshot | undefined;

    while (true) {
      if (signal.aborted) {
        throw this.stopRequested
          ? new ServiceError("port_exit", "Grok session stopped")
          : new ServiceError("turn_timeout", "Grok turn aborted");
      }

      const { response, rateLimits, streamed } = await this.createResponse({
        input,
        previousResponseId: responseId,
        signal
      });
      const nextResponseId = typeof response.id === "string" && response.id.trim().length > 0 ? response.id : null;
      if (!nextResponseId) {
        throw new ServiceError("response_error", "Grok response did not include an id");
      }
      this.previousResponseId = nextResponseId;
      responseId = nextResponseId;
      lastUsage = extractGrokUsage(response.usage) ?? lastUsage;
      if (rateLimits) {
        this.emit("notification", {
          rateLimits,
          message: humanizeGrokRateLimits(rateLimits)
        });
      }

      const responseError = asRecord(response.error);
      if (typeof responseError?.message === "string" && responseError.message.trim().length > 0) {
        throw new ServiceError("turn_failed", responseError.message.trim());
      }

      if (!streamed) {
        const assistantUpdates = extractAssistantUpdates(response);
        for (const update of assistantUpdates.reasoning) {
          this.emit("notification", {
            message: `reasoning update: ${truncateForLog(update)}`
          });
        }
        for (const update of assistantUpdates.messages) {
          this.emit("notification", {
            message: `assistant update: ${truncateForLog(update)}`
          });
        }
      }

      const functionCalls = extractFunctionCalls(response);
      if (functionCalls.length === 0) {
        const status = typeof response.status === "string" ? response.status : "completed";
        if (["failed", "cancelled", "incomplete", "errored"].includes(status)) {
          throw new ServiceError("turn_failed", `Grok turn ended with status ${status}`);
        }

        this.emit("turn_completed", {
          sessionId: this.sessionId,
          threadId: this.sessionId,
          turnId,
          usage: lastUsage
        });
        return;
      }

      if (toolRoundCount >= this.config.grok.maxToolRounds) {
        throw new ServiceError(
          "turn_failed",
          `Grok exceeded the configured tool round limit (${this.config.grok.maxToolRounds})`
        );
      }
      toolRoundCount += 1;

      const toolOutputs: Array<Record<string, unknown>> = [];
      for (const functionCall of functionCalls) {
        const result = await this.executeToolCall(functionCall, signal);
        toolOutputs.push({
          type: "function_call_output",
          call_id: functionCall.id,
          output: result.output
        });
      }
      input = toolOutputs;
    }
  }

  private async createResponse(params: {
    input: string | Array<Record<string, unknown>>;
    previousResponseId: string | null;
    signal: AbortSignal;
  }): Promise<{ response: GrokResponse; rateLimits: Record<string, unknown> | null; streamed: boolean }> {
    const body: Record<string, unknown> = {
      model: this.config.runtime.model,
      input: params.input,
      tools: grokToolDefinitions(),
      parallel_tool_calls: false,
      stream: true
    };
    if (params.previousResponseId) {
      body.previous_response_id = params.previousResponseId;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.grok.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.grok.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: params.signal
      });
    } catch (error) {
      if (params.signal.aborted) {
        throw this.stopRequested
          ? new ServiceError("port_exit", "Grok session stopped")
          : new ServiceError("turn_timeout", "Grok request aborted");
      }
      throw new ServiceError("grok_api_request", `Failed to reach Grok: ${errorMessage(error)}`);
    }

    const rateLimits = extractRateLimitHeaders(response.headers);
    const { response: payload, streamed } = await parseResponseBody(response, {
      onMessageDelta: (delta) => {
        const normalized = truncateForLog(delta);
        if (normalized.length > 0) {
          this.emit("notification", {
            message: `assistant update: ${normalized}`
          });
        }
      },
      onReasoningDelta: (delta) => {
        const normalized = truncateForLog(delta);
        if (normalized.length > 0) {
          this.emit("notification", {
            message: `reasoning update: ${normalized}`
          });
        }
      }
    });
    if (!response.ok) {
      const detail = extractApiErrorMessage(payload);
      throw new ServiceError(
        response.status === 401 ? "grok_auth_error" : "grok_api_status",
        detail ? `Grok API returned HTTP ${response.status}: ${detail}` : `Grok API returned HTTP ${response.status}`,
        {
          status: response.status,
          detail: detail ?? null,
          rate_limits: rateLimits
        }
      );
    }

    return {
      response: payload,
      rateLimits,
      streamed
    };
  }

  private async executeToolCall(functionCall: GrokFunctionCall, signal: AbortSignal): Promise<ToolExecutionResult> {
    const args = parseFunctionArguments(functionCall.argumentsText);
    const name = functionCall.name;
    this.emit("notification", {
      message: humanizeToolCall(name, args)
    });

    try {
      let output: string;
      switch (name) {
        case "run_command":
          output = await this.runCommandTool(args, signal);
          break;
        case "read_file":
          output = await this.readFileTool(args);
          break;
        case "write_file":
          output = await this.writeFileTool(args);
          break;
        case "replace_in_file":
          output = await this.replaceInFileTool(args);
          break;
        case "list_files":
          output = await this.listFilesTool(args);
          break;
        case "search_text":
          output = await this.searchTextTool(args);
          break;
        case "get_git_diff":
          output = await this.getGitDiffTool(args, signal);
          break;
        case LINEAR_GRAPHQL_TOOL_NAME:
          output = (await executeLinearGraphqlTool(this.config, args)).text;
          break;
        default:
          this.emit("unsupported_tool_call", {
            message: `unsupported tool call: ${name}`
          });
          return {
            output: JSON.stringify(
              {
                success: false,
                error: "unsupported_tool_call",
                message: `Tool ${name} is not available in OrchestrAI's Grok runtime`
              },
              null,
              2
            )
          };
      }

      this.emit("tool_call_completed", {
        message: `${name} completed`
      });
      return {
        output
      };
    } catch (error) {
      const message = `${name} failed: ${errorMessage(error)}`;
      this.emit("tool_call_failed", {
        message
      });
      return {
        output: JSON.stringify(
          {
            success: false,
            error: error instanceof ServiceError ? error.code : "tool_error",
            message: errorMessage(error)
          },
          null,
          2
        )
      };
    }
  }

  private async runCommandTool(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const command = expectNonEmptyString(args.command, "run_command requires a command");
    const requestedCwd = typeof args.cwd === "string" ? args.cwd : ".";
    const cwd = resolveWorkspacePath(this.workspacePath, requestedCwd);
    const timeoutMs = clampPositiveInteger(
      args.timeout_ms,
      this.config.grok.commandTimeoutMs,
      this.config.grok.commandTimeoutMs
    );

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (kind: "stdout" | "stderr", chunk: string) => {
      const limit = this.config.grok.maxOutputBytes;
      if (kind === "stdout") {
        stdout = appendWithLimit(stdout, chunk, limit);
        truncated ||= Buffer.byteLength(stdout, "utf8") >= limit;
      } else {
        stderr = appendWithLimit(stderr, chunk, limit);
        truncated ||= Buffer.byteLength(stderr, "utf8") >= limit;
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", String(chunk)));
    child.stderr?.on("data", (chunk) => append("stderr", String(chunk)));

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    }, timeoutMs);

    const abortHandler = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    const [code, signalName] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortHandler);

    return JSON.stringify(
      {
        success: code === 0 && !timedOut,
        command,
        cwd: path.relative(this.workspacePath, cwd) || ".",
        exit_code: code,
        signal: signalName,
        timed_out: timedOut,
        truncated,
        stdout,
        stderr
      },
      null,
      2
    );
  }

  private async readFileTool(args: Record<string, unknown>): Promise<string> {
    const targetPath = expectNonEmptyString(args.path, "read_file requires a path");
    const absolutePath = resolveWorkspacePath(this.workspacePath, targetPath);
    const startLine = Math.max(1, clampPositiveInteger(args.start_line, 1, Number.MAX_SAFE_INTEGER));
    const lineCount = clampPositiveInteger(args.line_count, DEFAULT_READ_LINE_COUNT, MAX_READ_LINE_COUNT);
    const content = await readFile(absolutePath, "utf8");
    const allLines = content.split("\n");
    const startIndex = Math.min(allLines.length, startLine - 1);
    const endIndex = Math.min(allLines.length, startIndex + lineCount);
    const rendered = allLines
      .slice(startIndex, endIndex)
      .map((line, index) => `${startIndex + index + 1}| ${line}`)
      .join("\n");

    return JSON.stringify(
      {
        success: true,
        path: path.relative(this.workspacePath, absolutePath) || path.basename(absolutePath),
        start_line: startIndex + 1,
        end_line: endIndex,
        total_lines: allLines.length,
        truncated: endIndex < allLines.length,
        content: rendered
      },
      null,
      2
    );
  }

  private async writeFileTool(args: Record<string, unknown>): Promise<string> {
    const targetPath = expectNonEmptyString(args.path, "write_file requires a path");
    const content = expectString(args.content, "write_file requires content");
    const absolutePath = resolveWorkspacePath(this.workspacePath, targetPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    return JSON.stringify(
      {
        success: true,
        path: path.relative(this.workspacePath, absolutePath) || path.basename(absolutePath),
        bytes_written: Buffer.byteLength(content, "utf8")
      },
      null,
      2
    );
  }

  private async replaceInFileTool(args: Record<string, unknown>): Promise<string> {
    const targetPath = expectNonEmptyString(args.path, "replace_in_file requires a path");
    const oldString = expectString(args.old_string, "replace_in_file requires old_string");
    const newString = expectString(args.new_string, "replace_in_file requires new_string");
    const replaceAll = args.replace_all === true;
    const absolutePath = resolveWorkspacePath(this.workspacePath, targetPath);
    const content = await readFile(absolutePath, "utf8");

    if (!oldString.length) {
      throw new ServiceError("invalid_tool_arguments", "replace_in_file old_string must not be empty");
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new ServiceError("invalid_tool_arguments", "replace_in_file could not find old_string in the target file");
    }
    if (!replaceAll && occurrences > 1) {
      throw new ServiceError(
        "invalid_tool_arguments",
        "replace_in_file found multiple matches; set replace_all=true to replace all occurrences"
      );
    }

    const nextContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await writeFile(absolutePath, nextContent, "utf8");

    return JSON.stringify(
      {
        success: true,
        path: path.relative(this.workspacePath, absolutePath) || path.basename(absolutePath),
        replaced: replaceAll ? occurrences : 1
      },
      null,
      2
    );
  }

  private async listFilesTool(args: Record<string, unknown>): Promise<string> {
    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const rootPath = resolveWorkspacePath(this.workspacePath, requestedPath);
    const pattern = typeof args.pattern === "string" && args.pattern.trim().length > 0 ? args.pattern.trim().toLowerCase() : null;
    const limit = clampPositiveInteger(args.limit, 200, 1000);
    const files = await collectWorkspaceFiles(rootPath, rootPath);
    const filtered = pattern ? files.filter((file) => file.toLowerCase().includes(pattern)) : files;
    const selected = filtered.slice(0, limit);

    return JSON.stringify(
      {
        success: true,
        root: path.relative(this.workspacePath, rootPath) || ".",
        count: selected.length,
        total_matches: filtered.length,
        truncated: filtered.length > selected.length,
        files: selected
      },
      null,
      2
    );
  }

  private async searchTextTool(args: Record<string, unknown>): Promise<string> {
    const query = expectNonEmptyString(args.query, "search_text requires query");
    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const rootPath = resolveWorkspacePath(this.workspacePath, requestedPath);
    const limit = clampPositiveInteger(args.limit, 50, 200);
    const caseSensitive = args.case_sensitive === true;
    const files = await collectWorkspaceFiles(rootPath, rootPath);
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
    const needle = caseSensitive ? query : query.toLowerCase();

    for (const relativePath of files) {
      if (matches.length >= limit) {
        break;
      }

      const absolutePath = path.join(rootPath, relativePath);
      const content = await readFile(absolutePath, "utf8").catch(() => null);
      if (typeof content !== "string" || content.includes("\u0000")) {
        continue;
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = caseSensitive ? lines[index] ?? "" : (lines[index] ?? "").toLowerCase();
        const matchIndex = haystack.indexOf(needle);
        if (matchIndex < 0) {
          continue;
        }

        matches.push({
          path: path.join(path.relative(this.workspacePath, rootPath), relativePath).replace(/^$/, relativePath).replace(/\\/g, "/"),
          line: index + 1,
          column: matchIndex + 1,
          text: lines[index] ?? ""
        });
        if (matches.length >= limit) {
          break;
        }
      }
    }

    return JSON.stringify(
      {
        success: true,
        query,
        root: path.relative(this.workspacePath, rootPath) || ".",
        count: matches.length,
        truncated: matches.length >= limit,
        matches
      },
      null,
      2
    );
  }

  private async getGitDiffTool(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const requestedPath = typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : null;
    const relativePath = requestedPath ? path.relative(this.workspacePath, resolveWorkspacePath(this.workspacePath, requestedPath)) : null;
    const childArgs = ["diff", "--no-ext-diff"];
    if (relativePath && relativePath.length > 0 && relativePath !== ".") {
      childArgs.push("--", relativePath);
    }

    const child = spawn("git", childArgs, {
      cwd: this.workspacePath,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (kind: "stdout" | "stderr", chunk: string) => {
      const limit = this.config.grok.maxOutputBytes;
      if (kind === "stdout") {
        stdout = appendWithLimit(stdout, chunk, limit);
        truncated ||= Buffer.byteLength(stdout, "utf8") >= limit;
      } else {
        stderr = appendWithLimit(stderr, chunk, limit);
        truncated ||= Buffer.byteLength(stderr, "utf8") >= limit;
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", String(chunk)));
    child.stderr?.on("data", (chunk) => append("stderr", String(chunk)));

    const abortHandler = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    const [code, signalName] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    signal.removeEventListener("abort", abortHandler);

    return JSON.stringify(
      {
        success: code === 0,
        path: relativePath,
        exit_code: code,
        signal: signalName,
        truncated,
        diff: stdout,
        stderr
      },
      null,
      2
    );
  }

  private failTurn(error: unknown): void {
    if (!this.currentTurn) {
      return;
    }

    const currentTurn = this.currentTurn;
    this.currentTurn = null;
    clearTimeout(currentTurn.timer);
    currentTurn.reject(error);
    if (error instanceof ServiceError && error.code !== "port_exit") {
      this.emit("turn_failed", {
        sessionId: this.sessionId,
        threadId: this.sessionId,
        turnId: currentTurn.turnId,
        message: error.message
      });
    }
  }

  private completeTurn(): void {
    if (!this.currentTurn) {
      return;
    }

    const currentTurn = this.currentTurn;
    this.currentTurn = null;
    clearTimeout(currentTurn.timer);
    currentTurn.resolve();
  }

  private emit(
    event: AgentRuntimeEvent["event"],
    payload: Omit<AgentRuntimeEvent, "event" | "timestamp" | "provider" | "agentProcessPid">
  ): void {
    this.onEvent({
      provider: "grok",
      event,
      timestamp: new Date().toISOString(),
      agentProcessPid: null,
      ...payload
    });
  }
}

function grokToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      type: "function",
      name: "run_command",
      description: "Run a shell command inside the current repository workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute."
          },
          cwd: {
            type: "string",
            description: "Optional workspace-relative directory to run the command from."
          },
          timeout_ms: {
            type: "integer",
            description: "Optional timeout override in milliseconds."
          }
        }
      }
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 text file from the repository workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root."
          },
          start_line: {
            type: "integer",
            description: "1-based line number to start reading from."
          },
          line_count: {
            type: "integer",
            description: "Maximum number of lines to return."
          }
        }
      }
    },
    {
      type: "function",
      name: "write_file",
      description: "Write a UTF-8 text file inside the repository workspace, creating parent directories if needed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root."
          },
          content: {
            type: "string",
            description: "Full file contents to write."
          }
        }
      }
    },
    {
      type: "function",
      name: "replace_in_file",
      description: "Replace a literal string in a UTF-8 text file inside the repository workspace.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "old_string", "new_string"],
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root."
          },
          old_string: {
            type: "string",
            description: "Existing literal text to replace."
          },
          new_string: {
            type: "string",
            description: "Replacement text."
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence instead of exactly one."
          }
        }
      }
    },
    {
      type: "function",
      name: "list_files",
      description: "List files inside the repository workspace without invoking a shell.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Optional workspace-relative directory to search from."
          },
          pattern: {
            type: "string",
            description: "Optional case-insensitive substring filter for returned paths."
          },
          limit: {
            type: "integer",
            description: "Maximum number of files to return."
          }
        }
      }
    },
    {
      type: "function",
      name: "search_text",
      description: "Search text inside repository files and return structured matches.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Literal text to search for."
          },
          path: {
            type: "string",
            description: "Optional workspace-relative directory to search from."
          },
          limit: {
            type: "integer",
            description: "Maximum number of matches to return."
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether to treat the query as case-sensitive."
          }
        }
      }
    },
    {
      type: "function",
      name: "get_git_diff",
      description: "Return the current git diff for the repo or for a specific file path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Optional workspace-relative file path to scope the diff."
          }
        }
      }
    },
    {
      type: "function",
      name: LINEAR_GRAPHQL_TOOL_NAME,
      description: linearGraphqlToolSpec().description,
      parameters: linearGraphqlToolSpec().inputSchema
    }
  ];
}

function parseFunctionArguments(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Function arguments must decode to an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ServiceError("invalid_tool_arguments", `Invalid function arguments: ${errorMessage(error)}`);
  }
}

function extractFunctionCalls(response: GrokResponse): GrokFunctionCall[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const calls: GrokFunctionCall[] = [];

  for (const item of output) {
    const record = asRecord(item);
    if (!record || record.type !== "function_call") {
      continue;
    }

    const callId = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : null;
    const name = typeof record.name === "string" ? record.name : null;
    const argumentsText = typeof record.arguments === "string" ? record.arguments : "{}";
    if (!callId || !name) {
      continue;
    }

    calls.push({
      id: callId,
      name,
      argumentsText
    });
  }

  return calls;
}

function extractAssistantUpdates(response: GrokResponse): { reasoning: string[]; messages: string[] } {
  const messages = new Set<string>();
  const reasoning = new Set<string>();

  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    messages.add(response.output_text.trim());
  }

  for (const item of Array.isArray(response.output) ? response.output : []) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    if (record.type === "message") {
      const content = Array.isArray(record.content) ? record.content : [];
      for (const contentItem of content) {
        const contentRecord = asRecord(contentItem);
        if (!contentRecord) {
          continue;
        }

        if (contentRecord.type === "output_text" && typeof contentRecord.text === "string" && contentRecord.text.trim().length > 0) {
          messages.add(contentRecord.text.trim());
        }
      }
    }

    if (record.type === "reasoning") {
      if (typeof record.summary === "string" && record.summary.trim().length > 0) {
        reasoning.add(record.summary.trim());
      }
      const summaryItems = Array.isArray(record.summary) ? record.summary : [];
      for (const summaryItem of summaryItems) {
        const summaryRecord = asRecord(summaryItem);
        if (summaryRecord && typeof summaryRecord.text === "string" && summaryRecord.text.trim().length > 0) {
          reasoning.add(summaryRecord.text.trim());
        }
      }
    }
  }

  return {
    reasoning: [...reasoning],
    messages: [...messages]
  };
}

function extractGrokUsage(usage: unknown): AgentUsageSnapshot | undefined {
  const record = asRecord(usage);
  if (!record) {
    return undefined;
  }

  const inputTokens = coerceNumber(record.input_tokens);
  const outputTokens = coerceNumber(record.output_tokens);
  const totalTokens = coerceNumber(record.total_tokens) || inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return undefined;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

async function parseResponseJson(response: Response): Promise<GrokResponse> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as GrokResponse;
  } catch (error) {
    throw new ServiceError("response_error", `Grok API returned invalid JSON: ${errorMessage(error)}`);
  }
}

async function parseResponseBody(
  response: Response,
  options: {
    onMessageDelta: (delta: string) => void;
    onReasoningDelta: (delta: string) => void;
  }
): Promise<{ response: GrokResponse; streamed: boolean }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return {
      response: await parseStreamingResponse(response, options),
      streamed: true
    };
  }

  return {
    response: await parseResponseJson(response),
    streamed: false
  };
}

async function parseStreamingResponse(
  response: Response,
  options: {
    onMessageDelta: (delta: string) => void;
    onReasoningDelta: (delta: string) => void;
  }
): Promise<GrokResponse> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {};
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const state: StreamingResponseState = {
    responseId: null,
    status: null,
    usage: undefined,
    error: undefined,
    outputItems: new Map(),
    functionArguments: new Map(),
    outputText: ""
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processStreamingFrame(frame, state, options);
      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim().length > 0) {
    processStreamingFrame(buffer, state, options);
  }

  if (state.finalResponse) {
    return state.finalResponse;
  }

  return buildStreamingFallbackResponse(state);
}

function extractApiErrorMessage(payload: GrokResponse): string | null {
  const record = asRecord(payload as unknown);
  if (!record) {
    return null;
  }

  const structuredError = asRecord(record.error);
  if (typeof structuredError?.message === "string" && structuredError.message.trim().length > 0) {
    return structuredError.message.trim();
  }

  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return record.error.trim();
  }

  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }

  if (typeof record.code === "string" && record.code.trim().length > 0) {
    return record.code.trim();
  }

  return null;
}

function extractRateLimitHeaders(headers: Headers): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  for (const [key, value] of headers.entries()) {
    if (!key.toLowerCase().startsWith("x-ratelimit-")) {
      continue;
    }
    values[key.toLowerCase()] = value;
  }

  return Object.keys(values).length > 0 ? values : null;
}

function humanizeGrokRateLimits(rateLimits: Record<string, unknown>): string {
  const remaining = typeof rateLimits["x-ratelimit-remaining-requests"] === "string"
    ? rateLimits["x-ratelimit-remaining-requests"]
    : typeof rateLimits["x-ratelimit-remaining"] === "string"
      ? rateLimits["x-ratelimit-remaining"]
      : null;
  return remaining ? `grok rate limit remaining: ${remaining}` : "grok rate limit updated";
}

function humanizeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_files":
      return `searching files: ${typeof args.pattern === "string" ? args.pattern : typeof args.path === "string" ? args.path : "."}`;
    case "search_text":
      return `searching text: ${typeof args.query === "string" ? args.query : ""}`;
    case "get_git_diff":
      return `reviewing repository state${typeof args.path === "string" ? `: ${args.path}` : ""}`;
    case "run_command":
      return `running command: ${truncateForLog(typeof args.command === "string" ? args.command : "", 180)}`;
    case "read_file":
      return `reading file: ${typeof args.path === "string" ? args.path : ""}`;
    case "write_file":
    case "replace_in_file":
      return `editing file: ${typeof args.path === "string" ? args.path : ""}`;
    case LINEAR_GRAPHQL_TOOL_NAME:
      return "querying Linear";
    default:
      return `using tool: ${name}`;
  }
}

function resolveWorkspacePath(workspacePath: string, requestedPath: string): string {
  if (requestedPath.length > MAX_TOOL_PATH_LENGTH) {
    throw new ServiceError("invalid_tool_arguments", "Path is too long");
  }

  const absoluteWorkspacePath = path.resolve(workspacePath);
  const candidate = path.resolve(absoluteWorkspacePath, requestedPath);
  if (candidate === absoluteWorkspacePath || candidate.startsWith(`${absoluteWorkspacePath}${path.sep}`)) {
    return candidate;
  }

  throw new ServiceError("invalid_tool_arguments", "Tool path must stay inside the workspace root");
}

function appendWithLimit(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  const buffer = Buffer.from(combined, "utf8");
  return buffer.subarray(0, maxBytes).toString("utf8");
}

type StreamingResponseState = {
  responseId: string | null;
  status: string | null;
  usage: unknown;
  error: GrokResponse["error"] | undefined;
  outputItems: Map<string, Record<string, unknown>>;
  functionArguments: Map<string, string>;
  outputText: string;
  finalResponse?: GrokResponse;
};

function processStreamingFrame(
  frame: string,
  state: StreamingResponseState,
  options: {
    onMessageDelta: (delta: string) => void;
    onReasoningDelta: (delta: string) => void;
  }
): void {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") {
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  updateStreamingState(payload, state, options);
}

function updateStreamingState(
  payload: Record<string, unknown>,
  state: StreamingResponseState,
  options: {
    onMessageDelta: (delta: string) => void;
    onReasoningDelta: (delta: string) => void;
  }
): void {
  const type = typeof payload.type === "string" ? payload.type : "";
  const responseRecord = asRecord(payload.response);
  if (responseRecord) {
    if (typeof responseRecord.id === "string" && responseRecord.id.trim().length > 0) {
      state.responseId = responseRecord.id;
    }
    if (typeof responseRecord.status === "string" && responseRecord.status.trim().length > 0) {
      state.status = responseRecord.status;
    }
    if (responseRecord.usage !== undefined) {
      state.usage = responseRecord.usage;
    }
    if (asRecord(responseRecord.error)) {
      state.error = responseRecord.error as GrokResponse["error"];
    }
  }

  if (type === "response.completed" || type === "response.failed" || type === "response.cancelled") {
    if (responseRecord) {
      state.finalResponse = responseRecord as GrokResponse;
    }
    return;
  }

  if (type === "response.output_text.delta") {
    const delta = asOptionalString(payload.delta);
    if (delta) {
      state.outputText += delta;
      options.onMessageDelta(delta);
    }
    return;
  }

  if (type.startsWith("response.reasoning") && type.endsWith(".delta")) {
    const delta = asOptionalString(payload.delta) ?? asOptionalString(payload.text);
    if (delta) {
      options.onReasoningDelta(delta);
    }
    return;
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = asRecord(payload.item);
    if (!item) {
      return;
    }

    const key = streamingItemKey(item) ?? streamingItemKey(payload);
    if (!key) {
      return;
    }
    state.outputItems.set(key, item);
    return;
  }

  if (type === "response.function_call.arguments.delta" || type === "response.function_call.delta") {
    const key = streamingItemKey(payload);
    const delta = asOptionalString(payload.delta);
    if (key && delta) {
      const nextArguments = `${state.functionArguments.get(key) ?? ""}${delta}`;
      state.functionArguments.set(key, nextArguments);
      const existing = state.outputItems.get(key) ?? { type: "function_call" };
      existing.arguments = nextArguments;
      state.outputItems.set(key, existing);
    }
    return;
  }

  if (type === "response.function_call.arguments.done") {
    const key = streamingItemKey(payload);
    const argumentsText = asOptionalString(payload.arguments);
    if (key && argumentsText) {
      state.functionArguments.set(key, argumentsText);
      const existing = state.outputItems.get(key) ?? { type: "function_call" };
      existing.arguments = argumentsText;
      state.outputItems.set(key, existing);
    }
  }
}

function buildStreamingFallbackResponse(state: StreamingResponseState): GrokResponse {
  const output = [...state.outputItems.values()].map((item) => {
    const key = streamingItemKey(item);
    if (key && state.functionArguments.has(key)) {
      return {
        ...item,
        arguments: state.functionArguments.get(key)
      };
    }
    return item;
  });

  if (state.outputText.trim().length > 0 && !output.some((item) => item.type === "message")) {
    output.push({
      type: "message",
      content: [
        {
          type: "output_text",
          text: state.outputText
        }
      ]
    });
  }

  return {
    id: state.responseId ?? undefined,
    status: state.status ?? "completed",
    output,
    output_text: state.outputText || undefined,
    usage: state.usage,
    error: state.error
  };
}

function streamingItemKey(record: Record<string, unknown>): string | null {
  return (
    asOptionalString(record.item_id) ??
    asOptionalString(record.call_id) ??
    asOptionalString(record.id) ??
    (typeof record.output_index === "number" ? `output_${record.output_index}` : null)
  );
}

async function collectWorkspaceFiles(rootPath: string, currentPath: string): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectWorkspaceFiles(rootPath, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(path.relative(rootPath, absolutePath).replace(/\\/g, "/"));
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function clampPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.trunc(value), max);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, max);
    }
  }
  return Math.min(fallback, max);
}

function expectNonEmptyString(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new ServiceError("invalid_tool_arguments", message);
}

function expectString(value: unknown, message: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new ServiceError("invalid_tool_arguments", message);
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function coerceNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
