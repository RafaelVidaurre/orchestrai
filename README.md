# OrchestrAI

OrchestrAI is a Linear-driven agent orchestration CLI. It watches project work, creates isolated workspaces, runs provider-backed coding agents, and exposes the same control plane through a CLI, dashboard, and TUI.

Built-in providers:

- `codex`
- `claude`
- `grok`

## Who This README Is For

This file is for humans:

- installation
- getting started
- configuration
- generated files and runtime state

Agent-facing guidance lives in [AGENTS.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/AGENTS.md). Maintainer and architecture notes live in [docs/MAINTAINERS.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/docs/MAINTAINERS.md).

## Requirements

- Node.js 22+
- Corepack-enabled Yarn 3
- Linear API access
- Provider-specific requirements:
  - `codex` on `PATH` for Codex
  - `claude` on `PATH` for Claude CLI
  - `XAI_API_KEY` for Grok

## Install

Until the package is published, install from a local checkout.

Build and use directly:

```bash
corepack enable
yarn install
yarn build
node dist/src/cli.js help
```

Or link it as a local CLI:

```bash
corepack enable
yarn install
yarn build
npm link
orchestrai help
```

If you want TypeScript imports such as `import { defineConfig } from "orchestrai/config"` in another project, also link the package into that consumer project:

```bash
npm link orchestrai
```

## Quick Start

Initialize an OrchestrAI root:

```bash
orchestrai init --root /path/to/orchestrai-root
```

Add a project backed by an existing local repository:

```bash
orchestrai project add \
  --root /path/to/orchestrai-root \
  --slug my-linear-project \
  --path /path/to/existing/repo \
  --name "My Project"
```

Add a project that should be cloned into managed workspaces:

```bash
orchestrai project add \
  --root /path/to/orchestrai-root \
  --slug my-linear-project \
  --clone example/my-repo \
  --repo example/my-repo \
  --name "My Project"
```

New projects are created disabled by default. Configure secrets first, then start them explicitly from the dashboard or with the runtime controls.

Start the dashboard:

```bash
orchestrai dashboard --root /path/to/orchestrai-root
```

Start the terminal UI:

```bash
orchestrai tui --root /path/to/orchestrai-root
```

Start the headless runtime:

```bash
orchestrai run --root /path/to/orchestrai-root
```

Preflight the setup:

```bash
orchestrai doctor --root /path/to/orchestrai-root
```

## Main Commands

```bash
orchestrai help
orchestrai init --root /path/to/orchestrai-root
orchestrai project add --root /path/to/orchestrai-root --slug my-project --path /path/to/repo
orchestrai providers list --root /path/to/orchestrai-root
orchestrai models list --root /path/to/orchestrai-root --provider grok
orchestrai doctor --root /path/to/orchestrai-root
orchestrai dashboard --root /path/to/orchestrai-root
orchestrai tui --root /path/to/orchestrai-root
orchestrai run --root /path/to/orchestrai-root
orchestrai migrate legacy --root /path/to/new-root --from /path/to/legacy-root
```

## Configuration

The source of truth is `orchestrai.config.ts`.

Example:

```ts
import { defineConfig } from "orchestrai/config";

export default defineConfig({
  version: 2,
  defaults: {
    pollingIntervalMs: 30000,
    maxConcurrentAgents: 10,
    agentProvider: "grok",
    agentModel: "grok-code-fast-1",
    providerOptions: {
      codex: {
        reasoningEffort: "medium"
      }
    }
  },
  projects: [
    {
      id: "storybook",
      displayName: "Storybook",
      enabled: false,
      projectSlug: "storybook",
      githubRepository: "example/storybook",
      source: {
        kind: "existingPath",
        path: "/absolute/path/to/storybook"
      },
      promptPath: "prompts/storybook.md",
      secrets: {
        useGlobalLinearApiKey: true,
        useGlobalXaiApiKey: true,
        useGlobalGithubToken: true
      }
    }
  ]
});
```

Important fields:

- `defaults`
  Shared polling, concurrency, provider, model, and provider options.
- `projects[*].enabled`
  Whether the project is allowed to run.
- `projects[*].projectSlug`
  The Linear project slug.
- `projects[*].source`
  Either:
  - `kind: "clone"` with a repository identifier
  - `kind: "existingPath"` with an absolute local path
- `projects[*].promptPath`
  Path to the human-authored prompt template for that project.
- `projects[*].secrets`
  Whether project secrets come from the root `.env.local` or the project-specific env file.

## Generated Files And Folders

OrchestrAI creates and uses several files under the root where it is initialized.

- `orchestrai.config.ts`
  Human-managed configuration. This is the file you edit or generate through the CLI/dashboard.
- `prompts/*.md`
  Human-managed prompt templates. These are the prompt bodies rendered with issue data.
- `.env.local`
  Root-level local secrets and shared defaults.
- `.orchestrai/projects/*.env`
  Per-project secret overrides.
- `.orchestrai/workspaces/*`
  Per-issue working copies where agents actually run.
- `.orchestrai/usage-metrics.json`
  Persisted usage ledger for current-month and lifetime totals.
- `.orchestrai/runtime/projects/*/WORKFLOW.md`
  Internal compiled runtime artifacts.

Do not edit `.orchestrai/runtime/projects/*/WORKFLOW.md` directly.

### Why The Prompt Appears Twice

This is expected today.

- `prompts/<project>.md` is the user-managed prompt source.
- `.orchestrai/runtime/projects/<project>/WORKFLOW.md` is an internal generated file that merges the prompt body with runtime config.

The runtime engine still consumes that generated workflow file as a compatibility bridge, so the prompt body is duplicated there on purpose. The generated file is not the source of truth.

## How Agents Receive Instructions

There are three instruction sources to keep distinct:

1. `prompts/*.md`
   This is the task prompt OrchestrAI renders with issue data.
2. The project repository's `AGENTS.md`
   This is where agent-specific repository instructions should live.
3. Human docs such as `README.md`
   These are for people, not for runtime policy.

For provider runtimes that do not natively read repo instructions, OrchestrAI's default prompt now tells the agent to inspect `AGENTS.md` before making changes.

## Usage Metrics

The dashboard now exposes two different scopes:

- current runtime session
  In-memory usage for the currently running process
- persisted usage ledger
  Current-month and lifetime totals stored in `.orchestrai/usage-metrics.json`

Persisted usage is tracked per project and per model. Current-session usage is shown separately so it is clear when you are looking at "what this process spent" versus "what this OrchestrAI root has spent this month".

Provider-reported cost is used when available. Otherwise OrchestrAI falls back to model pricing metadata and marks the cost source accordingly.

## Startup Guardrails

Projects are not meant to run blindly:

- new projects start disabled by default
- explicit project start now validates required runtime auth first
- runtime startup performs preflight checks on enabled projects
- `orchestrai doctor` reports configuration and provider issues

If required auth is missing, the project should fail preflight before an agent session starts.

## Legacy Migration

Legacy `WORKFLOW.md` setups are supported through explicit migration:

```bash
orchestrai migrate legacy \
  --root /path/to/new-orchestrai-root \
  --from /path/to/legacy-root
```

Migration will:

- read legacy workflows and `.env.local`
- create `orchestrai.config.ts`
- move prompt bodies into `prompts/*.md`
- copy per-project secrets into `.orchestrai/projects/*.env`

## Git Ignore

`orchestrai init` ensures the local workspace `.gitignore` contains:

```gitignore
.orchestrai/
.env.local
node_modules/
```

The runtime state under `.orchestrai/` is local and should not be committed.

## Testing

```bash
yarn check
yarn exec vitest run test/*.test.ts
yarn coverage
yarn build
```

## Where To Go Next

- [AGENTS.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/AGENTS.md) for agent-facing repository guidance
- [docs/MAINTAINERS.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/docs/MAINTAINERS.md) for architecture and release notes
