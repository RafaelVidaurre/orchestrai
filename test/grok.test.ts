import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimeEvent, ServiceConfig } from "../src/domain";
import { GrokApiSession } from "../src/grok";
import { ServiceError } from "../src/errors";
import { Logger } from "../src/logger";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("GrokApiSession", () => {
  it("chains responses through local function tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-session-"));
    tempRoots.push(root);
    await writeFile(path.join(root, "notes.txt"), "alpha\nbeta\n", "utf8");

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = mockJsonFetch(requests, [
      {
        id: "resp_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: JSON.stringify({ path: "notes.txt", start_line: 1, line_count: 5 })
          }
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          prompt_tokens_details: {
            cached_tokens: 2
          },
          cost_in_usd_ticks: 3500
        }
      },
      {
        id: "resp_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Read complete" }]
          }
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 6,
          total_tokens: 26,
          prompt_tokens_details: {
            cached_tokens: 5
          },
          cost_in_usd_ticks: 8500
        }
      }
    ]);

    const events = await runSession(root, fetchMock, "Inspect notes.txt");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]?.model).toBe("grok-code-fast-1");
    expect(requests[0]?.input).toBe("Inspect notes.txt");
    expect(requests[0]?.stream).toBe(true);
    expect(requests[1]?.previous_response_id).toBe("resp_1");
    expect(Array.isArray(requests[1]?.input)).toBe(true);
    expect(JSON.stringify(requests[1]?.input)).toContain("alpha");
    expect(events.some((event) => event.event === "tool_call_completed" && event.message === "read_file completed")).toBe(true);
    expect(events.some((event) => event.event === "notification" && event.message === "grok rate limit remaining: 99")).toBe(true);
    const completion = events.find((event) => event.event === "turn_completed");
    expect(completion?.usage).toEqual({
      input_tokens: 20,
      output_tokens: 6,
      total_tokens: 26,
      cache_read_input_tokens: 5,
      cost_usd: 0.00000085
    });
  });

  it("emits streaming assistant and reasoning updates from SSE responses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-stream-"));
    tempRoots.push(root);

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return sseResponse([
        {
          type: "response.reasoning.delta",
          delta: "Plan first."
        },
        {
          type: "response.output_text.delta",
          delta: "Streaming"
        },
        {
          type: "response.output_text.delta",
          delta: " output"
        },
        {
          type: "response.completed",
          response: {
            id: "resp_stream",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Streaming output" }]
              }
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              total_tokens: 10
            }
          }
        }
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await runSession(root, fetchMock, "Stream please");

    expect(requests[0]?.stream).toBe(true);
    expect(events.some((event) => event.message === "reasoning update: Plan first.")).toBe(true);
    expect(events.some((event) => event.message === "assistant update: Streaming")).toBe(true);
    expect(events.some((event) => event.message === "assistant update: output")).toBe(true);
    expect(events.some((event) => event.event === "turn_completed")).toBe(true);
  });

  it("uses structured list_files and search_text tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-search-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export const greeting = 'hello';\n", "utf8");
    await writeFile(path.join(root, "README.md"), "hello from docs\n", "utf8");

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = mockJsonFetch(requests, [
      {
        id: "resp_tools_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_list",
            name: "list_files",
            arguments: JSON.stringify({ path: ".", pattern: ".ts" })
          },
          {
            type: "function_call",
            call_id: "call_search",
            name: "search_text",
            arguments: JSON.stringify({ query: "hello", path: ".", limit: 5 })
          }
        ]
      },
      {
        id: "resp_tools_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Search done" }]
          }
        ],
        usage: {
          input_tokens: 9,
          output_tokens: 5,
          total_tokens: 14
        }
      }
    ]);

    const events = await runSession(root, fetchMock, "Use structured search tools");

    expect(events.some((event) => event.message === "list_files completed")).toBe(true);
    expect(events.some((event) => event.message === "search_text completed")).toBe(true);
    const toolOutputs = JSON.stringify(requests[1]?.input);
    expect(toolOutputs).toContain("src/main.ts");
    expect(toolOutputs).toContain("README.md");
    expect(toolOutputs).toContain("hello from docs");
  });

  it("returns git diff through the structured diff tool", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-diff-"));
    tempRoots.push(root);
    await writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], {
      cwd: root,
      stdio: "ignore"
    });
    await writeFile(path.join(root, "tracked.txt"), "after\n", "utf8");

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = mockJsonFetch(requests, [
      {
        id: "resp_diff_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_diff",
            name: "get_git_diff",
            arguments: JSON.stringify({ path: "tracked.txt" })
          }
        ]
      },
      {
        id: "resp_diff_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Diff done" }]
          }
        ]
      }
    ]);

    const events = await runSession(root, fetchMock, "Show repo diff");

    expect(events.some((event) => event.message === "get_git_diff completed")).toBe(true);
    const toolOutputs = JSON.stringify(requests[1]?.input);
    expect(toolOutputs).toContain("tracked.txt");
    expect(toolOutputs).toContain("-before");
    expect(toolOutputs).toContain("+after");
  });

  it("runs shell commands through the structured command tool", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-command-"));
    tempRoots.push(root);

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = mockJsonFetch(requests, [
      {
        id: "resp_cmd_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_cmd",
            name: "run_command",
            arguments: JSON.stringify({ command: "printf 'hello'" })
          }
        ]
      },
      {
        id: "resp_cmd_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Command done" }]
          }
        ]
      }
    ]);

    const events = await runSession(root, fetchMock, "Run a shell command");

    expect(events.some((event) => event.message === "run_command completed")).toBe(true);
    const toolOutputs = JSON.stringify(requests[1]?.input);
    expect(toolOutputs).toContain('\\"stdout\\": \\"hello\\"');
  });

  it("writes and replaces file content through structured file tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-write-"));
    tempRoots.push(root);

    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = mockJsonFetch(requests, [
      {
        id: "resp_write_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "notes.txt", content: "alpha" })
          },
          {
            type: "function_call",
            call_id: "call_replace",
            name: "replace_in_file",
            arguments: JSON.stringify({ path: "notes.txt", old_string: "alpha", new_string: "beta" })
          }
        ]
      },
      {
        id: "resp_write_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Write done" }]
          }
        ]
      }
    ]);

    const events = await runSession(root, fetchMock, "Write and edit a file");

    expect(events.some((event) => event.message === "write_file completed")).toBe(true);
    expect(events.some((event) => event.message === "replace_in_file completed")).toBe(true);
    expect(JSON.stringify(requests[1]?.input)).toContain('\\"replaced\\": 1');
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("beta");
  });

  it("surfaces top-level xAI permission errors in the thrown message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-permission-"));
    tempRoots.push(root);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: "The caller does not have permission to execute the specified operation",
          error: "Your newly created team doesn't have any credits or licenses yet."
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    vi.stubGlobal("fetch", fetchMock);
    const session = new GrokApiSession(
      configFixture(root),
      root,
      process.env,
      new Logger({}, { minimumLevel: "error", writeToStreams: false }),
      () => undefined
    );

    await session.start();

    await expect(session.runTurn("Reply with OK")).rejects.toMatchObject({
      name: "ServiceError",
      code: "grok_api_status",
      message: "Grok API returned HTTP 403: Your newly created team doesn't have any credits or licenses yet."
    } satisfies Partial<ServiceError>);
  });

  it("stops retrying repeated Linear HTTP 400 tool failures within the same turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-linear-400-"));
    tempRoots.push(root);

    const responsePayloads = [
      {
        id: "resp_linear_1",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_linear_1",
            name: "linear_graphql",
            arguments: JSON.stringify({ query: "query First { viewer { id } }" })
          }
        ]
      },
      {
        id: "resp_linear_2",
        status: "in_progress",
        output: [
          {
            type: "function_call",
            call_id: "call_linear_2",
            name: "linear_graphql",
            arguments: JSON.stringify({ query: "query Second { viewer { id } }" })
          }
        ]
      }
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        const payload = responsePayloads.shift();
        if (!payload) {
          throw new Error("Unexpected Grok responses call");
        }

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      if (url === "https://api.linear.app/graphql") {
        return new Response(JSON.stringify({}), {
          status: 400,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      throw new Error(`Unexpected fetch URL: ${url} body=${String(init?.body ?? "")}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const session = new GrokApiSession(
      configFixture(root),
      root,
      process.env,
      new Logger({}, { minimumLevel: "error", writeToStreams: false }),
      () => undefined
    );

    await session.start();

    await expect(session.runTurn("Try to update Linear twice")).rejects.toMatchObject({
      name: "ServiceError",
      code: "turn_failed",
      message: expect.stringContaining("linear_graphql is repeatedly failing with HTTP 400")
    } satisfies Partial<ServiceError>);
  });
});

async function runSession(root: string, fetchMock: ReturnType<typeof vi.fn>, prompt: string): Promise<AgentRuntimeEvent[]> {
  vi.stubGlobal("fetch", fetchMock);
  const events: AgentRuntimeEvent[] = [];
  const session = new GrokApiSession(
    configFixture(root),
    root,
    process.env,
    new Logger({}, { minimumLevel: "error", writeToStreams: false }),
    (event) => events.push(event)
  );

  await session.start();
  await session.runTurn(prompt);
  return events;
}

function mockJsonFetch(requests: Array<Record<string, unknown>>, payloads: unknown[]) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const payload = payloads.shift();
    if (!payload) {
      throw new Error("Unexpected fetch call");
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining-requests": "99"
      }
    });
  });
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  });
}

function configFixture(workspaceRoot: string): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    project: {
      displayName: null,
      enabled: true
    },
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "project-alpha",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"]
    },
    polling: {
      intervalMs: 30000
    },
    workspace: {
      root: workspaceRoot
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000
    },
    agent: {
      maxConcurrentAgents: 10,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
      maxTurns: 20
    },
    runtime: {
      provider: "grok",
      model: "grok-code-fast-1",
      turnTimeoutMs: 60000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000
    },
    codex: {
      command: "codex app-server",
      reasoningEffort: "medium",
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: null
    },
    claude: {
      command: "claude",
      permissionMode: "bypassPermissions",
      maxBudgetUsd: null
    },
    grok: {
      apiKey: "xai-test",
      baseUrl: "https://api.x.ai/v1",
      maxToolRounds: 4,
      commandTimeoutMs: 120000,
      maxOutputBytes: 65536
    },
    server: {
      port: 4318,
      host: "127.0.0.1"
    }
  };
}
