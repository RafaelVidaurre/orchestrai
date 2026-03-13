import type { ServiceConfig } from "./domain";
import { ServiceError } from "./errors";

const LINEAR_TOOL_TIMEOUT_MS = 30000;
export const LINEAR_GRAPHQL_TOOL_NAME = "linear_graphql";

const LINEAR_GRAPHQL_TOOL_DESCRIPTION =
  "Execute a raw GraphQL query or mutation against Linear using OrchestrAI's configured auth.";

const LINEAR_GRAPHQL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "GraphQL query or mutation document to execute against Linear."
    },
    variables: {
      type: ["object", "null"],
      description: "Optional GraphQL variables object.",
      additionalProperties: true
    }
  }
} as const;

interface LinearToolRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export interface LinearToolResult {
  success: boolean;
  text: string;
}

export function linearGraphqlToolSpec(): Record<string, unknown> {
  return {
    name: LINEAR_GRAPHQL_TOOL_NAME,
    description: LINEAR_GRAPHQL_TOOL_DESCRIPTION,
    inputSchema: LINEAR_GRAPHQL_INPUT_SCHEMA
  };
}

export async function executeLinearGraphqlTool(config: ServiceConfig, input: unknown): Promise<LinearToolResult> {
  const request = parseLinearToolRequest(input);
  if (!config.tracker.apiKey) {
    return failure("missing_tracker_api_key");
  }

  let response: Response;
  try {
    response = await fetch(config.tracker.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: config.tracker.apiKey
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(LINEAR_TOOL_TIMEOUT_MS)
    });
  } catch (error) {
    return failure("linear_api_request", error instanceof Error ? error.message : "Failed to reach Linear");
  }

  if (!response.ok) {
    return failure("linear_api_status", `HTTP ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return {
      success: false,
      text: JSON.stringify(
        {
          success: false,
          errors: payload.errors,
          data: payload.data ?? null
        },
        null,
        2
      )
    };
  }

  return {
    success: true,
    text: JSON.stringify(
      {
        success: true,
        data: payload.data ?? null
      },
      null,
      2
    )
  };
}

function parseLinearToolRequest(input: unknown): LinearToolRequest {
  if (typeof input === "string") {
    assertSingleOperation(input);
    return { query: input };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ServiceError("invalid_tool_arguments", "linear_graphql expects a query string or { query, variables }");
  }

  const query = (input as Record<string, unknown>).query;
  const variables = (input as Record<string, unknown>).variables;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ServiceError("invalid_tool_arguments", "linear_graphql requires a non-empty query string");
  }
  if (variables !== undefined && (!variables || typeof variables !== "object" || Array.isArray(variables))) {
    throw new ServiceError("invalid_tool_arguments", "linear_graphql variables must be an object when provided");
  }

  assertSingleOperation(query);
  return {
    query,
    variables: variables as Record<string, unknown> | undefined
  };
}

export function resolveDynamicToolName(params: Record<string, unknown>): string | null {
  if (typeof params.name === "string" && params.name.trim().length > 0) {
    return params.name.trim();
  }

  if (typeof params.tool === "string" && params.tool.trim().length > 0) {
    return params.tool.trim();
  }

  return null;
}

function assertSingleOperation(query: string): void {
  const stripped = query
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const matches = stripped.match(/\b(query|mutation|subscription)\b/g) ?? [];
  if (matches.length > 1) {
    throw new ServiceError("invalid_tool_arguments", "linear_graphql accepts exactly one GraphQL operation per call");
  }
}

function failure(code: string, message?: string): LinearToolResult {
  return {
    success: false,
    text: JSON.stringify(
      {
        success: false,
        error: code,
        message: message ?? null
      },
      null,
      2
    )
  };
}
