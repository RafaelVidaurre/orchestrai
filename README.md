# Symphony Orchestrator

This repository contains a TypeScript implementation of the [OpenAI Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) for unattended, Linear-driven repository work.

The service:

- polls Linear for active issues in one or more configured projects
- creates and reuses per-issue workspaces under a configured root
- loads runtime behavior from workflow Markdown files
- launches `codex app-server` inside each issue workspace
- requires Linear MCP to be available and authenticated inside the child Codex session
- reconciles live runs against tracker state, retries failures with backoff, and cleans terminal workspaces
- serves a live dashboard over HTTP with aggregated activity across projects

## Requirements

- Node.js 22+
- Corepack-enabled Yarn 3.4.1
- `codex` on `PATH`
- Linear MCP configured and authenticated in the Codex environment used by `codex app-server`

## Commands

```bash
corepack enable
yarn install
yarn build
yarn test
yarn start
```

## Workflow Resolution

The CLI accepts either a single workflow file or a directory of workflow files:

```bash
yarn start /abs/path/to/WORKFLOW.md
yarn start /abs/path/to/workflows
```

If no path is provided, startup resolution is:

1. `./workflows` if that directory exists
2. `./WORKFLOW.md`

Directory mode recursively loads files named `WORKFLOW.md` or `*.workflow.md`.

## Multi-Project Setup

Each workflow can point at a completely different Linear project and clone a completely different repository via `hooks.after_create`.

Example directory layout:

```text
workflows/
  game-client.workflow.md
  backend.workflow.md
```

Each workflow file loads env files from its own directory:

- `.env`
- `.env.local`

Precedence is:

1. existing shell environment
2. `.env.local`
3. `.env`

`.env.local` is gitignored.

## Observability

- Process logs are human-readable by default.
- Set `LOG_LEVEL=debug` for noisier runtime detail.
- Set `LOG_FORMAT=json` for structured logs.
- The dashboard aggregates all loaded workflows and shows per-project links, limits, active agents, queued retries, and recent orchestration events.
- If multiple workflows specify dashboard settings, the first enabled server config is used.

## Important Files

- [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/WORKFLOW.md): generic single-workflow template
- [`src/runtime.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/runtime.ts): multi-workflow startup and aggregated snapshots
- [`src/orchestrator.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/orchestrator.ts): per-workflow poll loop, dispatch, retries, reconciliation
- [`src/status-server.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/status-server.ts): live aggregated dashboard
- [`src/tracker.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/tracker.ts): Linear GraphQL adapter and project/rate-limit discovery
- [`src/workspace.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/workspace.ts): workspace safety and hook execution

## Notes

- The runtime prefers Linear MCP and fails worker startup if Linear MCP is missing or unauthenticated.
- A limited `linear_graphql` dynamic tool handler still exists as a fallback path when Codex issues that tool call.
