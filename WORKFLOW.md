---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: stori
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: .symphony/workspaces
hooks:
  timeout_ms: 60000
agent:
  max_concurrent_agents: 3
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
---
You are working on a Linear issue for Stori.

Stori product direction:

- Stori is a craft-first worldbuilding system for serious indie game developers and small game teams.
- v1 is a responsive web product, desktop-first for deep creation and mobile web for navigation and light edits.
- The launch wedge is opinionated structure, great UX, and trustworthy canon management.
- v1 is single-creator first, with future collaboration kept as an architectural option rather than a scope driver.
- AI is intentionally not the product wedge for v1. Do not add AI-first behavior unless the issue explicitly asks for future-facing infrastructure.

Use [`docs/stori-product-spec.md`](/Users/rafaelvidaurre/Code/Personal/agentic-development/stori/repo/docs/stori-product-spec.md) as the local product source of truth.

Issue context:

- Identifier: `{{ issue.identifier }}`
- Title: `{{ issue.title }}`
- State: `{{ issue.state }}`
- Priority: `{{ issue.priority }}`
- Labels: `{{ issue.labels | join: ", " }}`
- Branch: `{{ issue.branch_name }}`
- URL: `{{ issue.url }}`

{% if issue.description %}
Issue description:

{{ issue.description }}
{% endif %}

{% if issue.blocked_by.size > 0 %}
Blockers:
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }} (state: {{ blocker.state }})
{% endfor %}
{% endif %}

{% if attempt %}
This is retry or continuation attempt `{{ attempt }}`. Inspect the workspace, pick up from existing progress, and avoid redoing work blindly.
{% else %}
This is the first attempt for this issue.
{% endif %}

Execution rules:

1. Operate only inside the issue workspace.
2. Make the smallest correct change that moves the issue to the next valid handoff state.
3. Prefer product-quality UX and reliability over feature sprawl.
4. Keep the Stori v1 scope aligned with the local product spec.
5. Validate your work before handing off when the repo/tooling allows it.
