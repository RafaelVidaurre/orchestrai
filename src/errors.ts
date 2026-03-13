export class ServiceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceError";
    this.code = code;
    this.details = details;
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

export function errorMessage(value: unknown): string {
  return toError(value).message;
}

export function formatError(value: unknown): Record<string, unknown> {
  const error = toError(value);
  const payload: Record<string, unknown> = {
    error_name: error.name,
    error_message: error.message
  };

  if (error instanceof ServiceError) {
    payload.error_code = error.code;
    if (error.details) {
      payload.error_details = error.details;
    }
  }

  if (error.stack) {
    payload.error_stack = error.stack;
  }

  return payload;
}
