import { formatError } from "./errors";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFormat = "pretty" | "json";

interface LoggerOptions {
  minimumLevel?: LogLevel;
  format?: LogFormat;
}

export class Logger {
  private readonly minimumLevel: LogLevel;
  private readonly format: LogFormat;

  constructor(
    private readonly bindings: Record<string, unknown> = {},
    options: LoggerOptions = {}
  ) {
    this.minimumLevel = options.minimumLevel ?? "info";
    this.format = options.format ?? "pretty";
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(
      { ...this.bindings, ...bindings },
      {
        minimumLevel: this.minimumLevel,
        format: this.format
      }
    );
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  errorWithCause(message: string, error: unknown, fields?: Record<string, unknown>): void {
    this.write("error", message, {
      ...fields,
      ...formatError(error)
    });
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...(fields ?? {})
    };

    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    if (this.format === "json") {
      stream.write(`${JSON.stringify(payload)}\n`);
      return;
    }

    const { timestamp, component, error_stack, ...rest } = payload;
    const renderedFields = Object.entries(rest)
      .filter(([key]) => !["level", "message"].includes(key))
      .map(([key, value]) => `${key}=${renderValue(value)}`)
      .join(" ");
    const prefix = [String(timestamp), level.toUpperCase(), component ? `[${component}]` : null]
      .filter(Boolean)
      .join(" ");
    stream.write(`${prefix} ${message}${renderedFields ? ` ${renderedFields}` : ""}\n`);
    if (typeof error_stack === "string" && error_stack.length > 0) {
      stream.write(`${indentLines(error_stack)}\n`);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    return order.indexOf(level) >= order.indexOf(this.minimumLevel);
  }
}

export function createRootLoggerFromEnv(env: NodeJS.ProcessEnv = process.env): Logger {
  const rawLevel = env.LOG_LEVEL?.toLowerCase();
  const minimumLevel: LogLevel =
    rawLevel === "debug" || rawLevel === "info" || rawLevel === "warn" || rawLevel === "error" ? rawLevel : "info";
  const format: LogFormat = env.LOG_FORMAT === "json" ? "json" : "pretty";
  return new Logger({}, { minimumLevel, format });
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function indentLines(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
