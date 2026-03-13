# Stori Symphony

This repository contains a TypeScript implementation of the [OpenAI Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md), tailored for the Stori project.

The service:

- polls Linear for active issues in a configured project
- creates and reuses per-issue workspaces under `.symphony/workspaces`
- loads all runtime behavior from the repo-owned [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/WORKFLOW.md)
- launches `codex app-server` inside each issue workspace
- reconciles live runs against tracker state, retries failures with backoff, and cleans terminal workspaces

## Trust Posture

This port is intentionally high-trust by default:

- `codex.approval_policy`: `never`
- `codex.thread_sandbox`: `workspace-write`
- unexpected approval prompts are auto-approved for the session
- user-input requests hard-fail the active run
- unsupported dynamic tool calls are rejected instead of stalling the session

If you need a stricter deployment, change the `codex` section in [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/WORKFLOW.md).

## Requirements

- Node.js 22+
- `codex` on `PATH`
- `LINEAR_API_KEY` available either in the shell environment, `.env`, or `.env.local`
- a valid Linear project slug in [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/WORKFLOW.md)

## Commands

```bash
npm install
npm run build
npm test
npm start
```

## Env Files

The CLI loads env files from the same directory as [`WORKFLOW.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/WORKFLOW.md):

- `.env`
- `.env.local`

Precedence is:

1. existing shell environment
2. `.env.local`
3. `.env`

`.env.local` is gitignored.

## Important Files

- [`src/orchestrator.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/orchestrator.ts): poll loop, dispatch, retries, reconciliation
- [`src/codex.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/codex.ts): stdio app-server client for Codex
- [`src/tracker.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/tracker.ts): Linear GraphQL adapter and issue normalization
- [`src/workspace.ts`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/src/workspace.ts): workspace safety and hook execution
- [`docs/stori-product-spec.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/docs/stori-product-spec.md): local copy of the March 13, 2026 product direction

## Notes

- The default `project_slug` is set to `stori` as a starting assumption. Change it if the Linear project slug differs.
- The optional `linear_graphql` client-side tool extension from the Symphony spec is not implemented yet.
