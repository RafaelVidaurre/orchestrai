# OrchestrAI

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
yarn tui
```

## Running OrchestrAI

- `yarn start` runs the service and dashboard in headless mode.
- `yarn tui` launches the terminal UI. It starts the runtime and dashboard, shows live status, and `Space` opens the dashboard in your browser.

If no workflows exist yet, OrchestrAI still starts and the dashboard can be used to configure the first project.

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
- The dashboard uses an operations-first, shadcn-inspired layout with a left project rail, live agent tables, and a settings sheet for global defaults plus project overrides.
- The TUI is built with Ink and focuses on the most legible operator signals: active agents, elapsed runtime, retries, dashboard status, and current activity summaries.
- If multiple workflows specify dashboard settings, the first enabled server config is used.

## Design Direction

The operator surfaces in this repo follow the same basic direction described in OpenAI's [Harness Engineering](https://openai.com/index/harness-engineering/):

- make active agent work legible at a glance
- keep repository and workflow files as the system of record
- separate day-to-day operations from configuration and setup

## Important Files

- [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/WORKFLOW.md): generic single-workflow template
- [`src/app-controller.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/app-controller.ts): shared runtime and dashboard control plane used by CLI, TUI, and dashboard setup
- [`src/runtime.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/runtime.ts): multi-workflow startup and aggregated snapshots
- [`src/tui.tsx`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/tui.tsx): Ink-based terminal UI entrypoint
- [`src/status-server.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/status-server.ts): live aggregated dashboard and project setup API
- [`src/project-setup.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/project-setup.ts): workflow and env scaffolding for new projects

## Notes

- The runtime prefers Linear MCP and fails worker startup if Linear MCP is missing or unauthenticated.
- A limited `linear_graphql` dynamic tool handler still exists as a fallback path when Codex issues that tool call.
