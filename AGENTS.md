# AGENTS.md

This file is the agent-facing entrypoint for the OrchestrAI repository.

If you are an agent working in this repo, read these files next:

- [docs/MAINTAINERS.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/docs/MAINTAINERS.md)
  Architecture, plugin boundaries, runtime layering, packaging notes, and testing expectations.
- [src/plugin-sdk.ts](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/plugin-sdk.ts)
  Provider plugin contract.
- [src/provider-registry.ts](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/provider-registry.ts)
  Built-in and external provider discovery.
- [src/control-plane.ts](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/control-plane.ts)
  Shared application service used by the CLI, dashboard, and TUI.
- [src/config-backed-projects.ts](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/config-backed-projects.ts)
  Config persistence, prompt files, generated runtime workflows, and workspace bootstrap behavior.
- [src/orchestrai-config.ts](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/src/orchestrai-config.ts)
  Config v2 schema and normalization.

## Repository Rules

- Treat `orchestrai.config.ts` and `prompts/*.md` as human-managed source files.
- Treat `.orchestrai/runtime/projects/*/WORKFLOW.md` as generated compatibility artifacts. Do not hand-edit them.
- Keep provider-specific behavior inside provider plugins or provider runtime modules, not inside the core control plane.
- If you change runtime prompts or startup behavior, verify both the dashboard flow and the TUI flow because both share the same control plane.
- If you change usage accounting, keep the distinction clear between:
  - current runtime session
  - persisted monthly/lifetime usage ledger

## Human Docs

The human-oriented onboarding and usage guide lives in [README.md](/Users/rafaelvidaurre/Code/Personal/agentic-development/orchestrai/README.md). Do not overload it with agent-only implementation notes.
