---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $PROJECT_SLUG
  active_states:
    - Todo
    - In Progress
    - Human Review
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: .orchestrai/workspaces
hooks:
  timeout_ms: "60000"
  after_create: >
    set -euo pipefail

    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
      git clone "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" repo
    else
      git clone "git@github.com:${GITHUB_REPOSITORY}.git" repo || git clone "https://github.com/${GITHUB_REPOSITORY}.git" repo
    fi
agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
server:
  port: "-1"
project:
  enabled: true
  name: Stori
---
You are working on a Linear issue.

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
This is retry or continuation attempt `{{ attempt }}`. Inspect the workspace, continue from existing progress, and avoid repeating completed work.
{% else %}
This is the first attempt for this issue.
{% endif %}

Execution rules:

1. Operate only inside the issue workspace.
2. Use the repository checked out by the workflow hooks. Do not touch any unrelated path.
3. Make the smallest correct change that moves the issue to the next valid handoff state.
4. Use the configured Linear MCP for issue reads and writes. If Linear MCP is unavailable or unauthenticated, stop immediately and surface that blocker.
5. Validate your work before handing off when the repo tooling allows it.
