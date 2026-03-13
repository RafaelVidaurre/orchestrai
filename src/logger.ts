import { formatError } from "./errors";

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  constructor(
    private readonly bindings: Record<string, unknown> = {},
    private readonly minimumLevel: LogLevel = "info"
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({ ...this.bindings, ...bindings }, this.minimumLevel);
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

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...(fields ?? {})
    };

    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(payload)}\n`);
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    return order.indexOf(level) >= order.indexOf(this.minimumLevel);
  }
}
