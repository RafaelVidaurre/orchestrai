function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function mapPath(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;

  for (const segment of path) {
    const next = asRecord(current);
    if (!next || !(segment in next)) {
      return undefined;
    }
    current = next[segment];
  }

  return current;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeNarrativeInline(value: string): string {
  return sanitizeInline(value)
    .replace(/[\u00ad\u200b\u200c\u200d]/g, "")
    .replace(/[‐‑‒–—]/g, "-");
}

function dynamicToolName(payload: Record<string, unknown>): string | null {
  return asString(mapPath(payload, ["params", "tool"])) ?? asString(mapPath(payload, ["params", "name"]));
}

function extractCommand(payload: Record<string, unknown>): string | null {
  return (
    asString(mapPath(payload, ["params", "parsedCmd"])) ??
    asString(mapPath(payload, ["params", "command"])) ??
    asString(mapPath(payload, ["params", "cmd"])) ??
    asString(mapPath(payload, ["params", "msg", "command"]))
  );
}

function extractLinearQuery(payload: Record<string, unknown>): string | null {
  const args = mapPath(payload, ["params", "arguments"]);
  if (typeof args === "string") {
    return args;
  }

  if (args && typeof args === "object" && !Array.isArray(args)) {
    return asString((args as Record<string, unknown>).query);
  }

  return null;
}

function extractDiff(payload: Record<string, unknown>): string | null {
  return asString(mapPath(payload, ["params", "diff"])) ?? asString(mapPath(payload, ["params", "msg", "payload", "diff"]));
}

function countDiffLines(payload: Record<string, unknown>): number | null {
  const diff = extractDiff(payload);
  if (!diff) {
    return null;
  }

  return diff.split("\n").filter((line) => line.trim().length > 0).length;
}

function extractEditedFiles(payload: Record<string, unknown>): string[] {
  const diff = extractDiff(payload);
  if (!diff) {
    return [];
  }

  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const diffGitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffGitMatch) {
      files.add(diffGitMatch[2]);
      continue;
    }

    const plusPlusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusPlusMatch && plusPlusMatch[1] !== "/dev/null") {
      files.add(plusPlusMatch[1]);
    }
  }

  return [...files];
}

function summarizeEditedFiles(files: string[]): string {
  if (files.length === 0) {
    return "edited files";
  }

  const shown = files.slice(0, 3);
  const suffix = files.length > shown.length ? `, +${files.length - shown.length} more` : "";
  return `edited ${files.length} file${files.length === 1 ? "" : "s"}: ${shown.join(", ")}${suffix}`;
}

function humanizeCommand(command: string, mode: "start" | "finish"): string {
  const compact = sanitizeInline(command);
  const lower = compact.toLowerCase();
  const prefix = mode === "start" ? "running command" : "finished command";

  if (/\bgh\s+pr\s+create\b/.test(lower)) {
    return mode === "start" ? "submitting pull request" : "pull request submitted";
  }

  if (/\bgh\s+pr\s+(view|checks|comment|review)\b/.test(lower) || /\bgh\s+api\b/.test(lower) && /\bpulls?\b/.test(lower)) {
    return mode === "start" ? "checking pull request status" : "pull request check finished";
  }

  if (/\bgit\s+push\b/.test(lower)) {
    return mode === "start" ? "pushing branch updates" : "branch push finished";
  }

  if (/\bgit\s+commit\b/.test(lower)) {
    return mode === "start" ? "committing changes" : "commit finished";
  }

  if (/\b(yarn|npm|pnpm|bun)\b.*\b(test|check|build|lint)\b/.test(lower) || /\b(vitest|jest|pytest|mix test|cargo test)\b/.test(lower)) {
    return mode === "start" ? "running validation" : "validation command finished";
  }

  if (/\bgit\s+(status|diff|show)\b/.test(lower)) {
    return mode === "start" ? "reviewing repository state" : "repository inspection finished";
  }

  if (/\b(rg|sed|cat|ls|find)\b/.test(lower)) {
    return mode === "start" ? "reading project files" : "file inspection finished";
  }

  return `${prefix}: ${compact}`;
}

function humanizeLinearToolRequest(payload: Record<string, unknown>): string | null {
  const query = extractLinearQuery(payload);
  if (!query) {
    return null;
  }

  const normalized = query.replace(/\s+/g, " ").toLowerCase();
  if (normalized.includes("commentcreate") || normalized.includes("commentupdate")) {
    return "updating workpad in Linear";
  }
  if (normalized.includes("issueupdate")) {
    if (normalized.includes("stateid") || normalized.includes("state")) {
      return "changing task status in Linear";
    }
    return "updating task in Linear";
  }
  if (normalized.includes("attachmentcreate") || normalized.includes("attachmentlink") || normalized.includes("link")) {
    return "linking pull request in Linear";
  }
  if (normalized.includes("issuecreate")) {
    return "creating follow-up task in Linear";
  }
  if (normalized.includes("issue(") || normalized.includes("issues(") || normalized.includes("project(") || normalized.includes("comments(")) {
    return "reading Linear context";
  }

  return "querying Linear";
}

function tokenUsageText(payload: Record<string, unknown>): string | null {
  const usageRecord =
    asRecord(mapPath(payload, ["params", "tokenUsage", "total"])) ??
    asRecord(mapPath(payload, ["params", "usage"])) ??
    asRecord(mapPath(payload, ["params", "msg", "payload", "total_token_usage"])) ??
    asRecord(mapPath(payload, ["params", "msg", "payload", "last_token_usage"])) ??
    asRecord(mapPath(payload, ["usage"]));

  if (!usageRecord) {
    return null;
  }

  const input = numericValue(usageRecord.inputTokens ?? usageRecord.input_tokens);
  const output = numericValue(usageRecord.outputTokens ?? usageRecord.output_tokens);
  const total = numericValue(usageRecord.totalTokens ?? usageRecord.total_tokens);

  if (input === null && output === null && total === null) {
    return null;
  }

  return `in ${input ?? "?"}, out ${output ?? "?"}, total ${total ?? "?"}`;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanizeWrapperEvent(suffix: string, payload: Record<string, unknown>): string | null {
  switch (suffix) {
    case "task_started":
      return "task started";
    case "user_message":
      return "user message received";
    case "turn_diff": {
      const files = extractEditedFiles(payload);
      if (files.length > 0) {
        return summarizeEditedFiles(files);
      }

      const lines = countDiffLines(payload);
      return lines === null ? "turn diff updated" : `turn diff updated (${lines} lines)`;
    }
    case "token_count": {
      const usage = tokenUsageText(payload);
      return usage ? `token count update (${usage})` : "token count update";
    }
    case "exec_command_begin": {
      const command = extractCommand(payload);
      return command ? humanizeCommand(command, "start") : "command started";
    }
    case "exec_command_end": {
      const command = extractCommand(payload);
      return command ? humanizeCommand(command, "finish") : "command completed";
    }
    case "exec_command_output_delta":
      return "command output streaming";
    case "agent_message_delta":
    case "agent_message_content_delta": {
      const delta = asString(mapPath(payload, ["params", "msg", "payload", "delta"]));
      return delta ? `agent message streaming: ${sanitizeInline(delta)}` : "agent message streaming";
    }
    case "agent_reasoning_delta":
    case "reasoning_content_delta":
      return "reasoning streaming";
    case "agent_reasoning": {
      const summary = asString(mapPath(payload, ["params", "msg", "payload", "summaryText"]));
      return summary ? `reasoning update: ${sanitizeInline(summary)}` : "reasoning update";
    }
    case "mcp_startup_complete":
      return "mcp startup complete";
    default:
      return suffix.replaceAll("_", " ");
  }
}

export function humanizeCodexMethod(method: string, payload: Record<string, unknown>): string {
  switch (method) {
    case "thread/tokenUsage/updated": {
      const usage = tokenUsageText(payload);
      return usage ? `thread token usage updated (${usage})` : "thread token usage updated";
    }
    case "account/rateLimits/updated":
      return "rate limits updated";
    case "item/commandExecution/requestApproval": {
      const command = extractCommand(payload);
      return command ? `command approval requested (${sanitizeInline(command)})` : "command approval requested";
    }
    case "item/fileChange/requestApproval": {
      const count = numericValue(mapPath(payload, ["params", "fileChangeCount"]) ?? mapPath(payload, ["params", "changeCount"]));
      return count ? `file change approval requested (${count} files)` : "file change approval requested";
    }
    case "item/tool/requestUserInput": {
      const question = asString(mapPath(payload, ["params", "question"])) ?? asString(mapPath(payload, ["params", "prompt"]));
      return question ? `tool requires user input: ${sanitizeInline(question)}` : "tool requires user input";
    }
    case "item/tool/call": {
      const tool = dynamicToolName(payload);
      if (tool === "linear_graphql") {
        return humanizeLinearToolRequest(payload) ?? "querying Linear";
      }
      return tool ? `dynamic tool call requested (${tool})` : "dynamic tool call requested";
    }
    case "item/commandExecution/outputDelta":
      return "command output streaming";
    case "item/fileChange/outputDelta":
      return "file change output streaming";
    case "item/agentMessage/delta": {
      const delta = asString(mapPath(payload, ["params", "delta"])) ?? asString(mapPath(payload, ["params", "textDelta"]));
      return delta ? `agent message streaming: ${sanitizeInline(delta)}` : "agent message streaming";
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return "reasoning streaming";
    case "turn/diff/updated": {
      const files = extractEditedFiles(payload);
      if (files.length > 0) {
        return summarizeEditedFiles(files);
      }

      const lines = countDiffLines(payload);
      return lines === null ? "turn diff updated" : `turn diff updated (${lines} lines)`;
    }
    default:
      if (method.startsWith("codex/event/")) {
        return humanizeWrapperEvent(method.slice("codex/event/".length), payload) ?? method;
      }
      return method;
  }
}

export function humanizeDynamicToolEvent(base: string, toolName: string | null): string {
  return toolName && toolName.trim().length > 0 ? `${base} (${toolName.trim()})` : base;
}

const SUMMARY_NOTIFICATION_PREFIXES = [
  "task started",
  "command approval requested",
  "file change approval requested",
  "tool requires user input",
  "dynamic tool call requested",
  "dynamic tool call completed",
  "dynamic tool call failed",
  "reading Linear context",
  "updating workpad in Linear",
  "changing task status in Linear",
  "updating task in Linear",
  "linking pull request in Linear",
  "creating follow-up task in Linear",
  "querying Linear",
  "submitting pull request",
  "pull request submitted",
  "checking pull request status",
  "pull request check finished",
  "pushing branch updates",
  "branch push finished",
  "committing changes",
  "commit finished",
  "running validation",
  "validation command finished",
  "edited ",
  "rate limits updated",
  "linear mcp"
] as const;

const TRANSCRIPT_NOTIFICATION_PREFIXES = [
  ...SUMMARY_NOTIFICATION_PREFIXES,
  "thread token usage updated",
  "token count update",
  "running command:",
  "finished command:",
  "reading project files",
  "file inspection finished",
  "reviewing repository state",
  "repository inspection finished",
  "command completed",
  "command output streaming",
  "file change output streaming",
  "reasoning update",
  "reasoning streaming",
  "agent message streaming",
  "turn diff updated"
] as const;

export function shouldRecordHumanizedCodexNotification(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return SUMMARY_NOTIFICATION_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function shouldCaptureHumanizedCodexTranscript(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return TRANSCRIPT_NOTIFICATION_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function classifyHumanizedCodexMessage(
  message: string
): "status" | "message" | "reasoning" | "command" | "tool" | "approval" | "system" {
  if (message.startsWith("agent message streaming")) {
    return "message";
  }

  if (message.startsWith("reasoning")) {
    return "reasoning";
  }

  if (
    message.startsWith("command output streaming") ||
    message.startsWith("command completed") ||
    message.startsWith("running command:") ||
    message.startsWith("finished command:") ||
    message.startsWith("submitting pull request") ||
    message.startsWith("pull request submitted") ||
    message.startsWith("pushing branch updates") ||
    message.startsWith("branch push finished") ||
    message.startsWith("committing changes") ||
    message.startsWith("commit finished") ||
    message.startsWith("running validation") ||
    message.startsWith("validation command finished") ||
    message.startsWith("reading project files") ||
    message.startsWith("file inspection finished") ||
    message.startsWith("reviewing repository state") ||
    message.startsWith("repository inspection finished") ||
    message.startsWith("edited ")
  ) {
    return "command";
  }

  if (
    message.startsWith("dynamic tool call") ||
    message.startsWith("reading Linear context") ||
    message.startsWith("updating workpad in Linear") ||
    message.startsWith("changing task status in Linear") ||
    message.startsWith("updating task in Linear") ||
    message.startsWith("linking pull request in Linear") ||
    message.startsWith("creating follow-up task in Linear") ||
    message.startsWith("querying Linear")
  ) {
    return "tool";
  }

  if (
    message.startsWith("command approval requested") ||
    message.startsWith("file change approval requested") ||
    message.startsWith("tool requires user input")
  ) {
    return "approval";
  }

  if (message.startsWith("linear mcp")) {
    return "system";
  }

  return "status";
}

export function normalizeTranscriptMessage(
  kind: "status" | "message" | "reasoning" | "command" | "tool" | "approval" | "system",
  message: string
): string | null {
  const trimmed = sanitizeNarrativeInline(message).trim();
  if (trimmed.length === 0) {
    return null;
  }

  switch (kind) {
    case "message":
      return stripStreamingPrefix(trimmed, "agent message streaming");
    case "reasoning":
      return stripStreamingPrefix(trimmed, "reasoning update", "reasoning streaming");
    default:
      return trimmed;
  }
}

export function isNarrativeTranscriptKind(
  kind: "status" | "message" | "reasoning" | "command" | "tool" | "approval" | "system"
): boolean {
  return kind === "message" || kind === "reasoning";
}

export function stitchTranscriptMessages(previous: string, next: string): string {
  const left = previous.trim();
  const right = next.trim().replace(/^-\s+/, "");
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const needsSpace = !/[ \n]$/.test(left) && !/^[,.;:!?]/.test(right);
  return `${left}${needsSpace ? " " : ""}${right}`;
}

function stripStreamingPrefix(value: string, ...prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (value === prefix) {
      return null;
    }

    if (value.startsWith(`${prefix}:`)) {
      const stripped = value.slice(prefix.length + 1).trim();
      return stripped.length > 0 ? stripped : null;
    }
  }

  return value;
}
