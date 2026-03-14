---
name: land
description:
  Land a PR by discovering or creating the PR if needed, waiting for approvals
  and checks, and merging when green. Use when asked to land, merge, or
  shepherd a PR through the Merging state.
---

# Land

## Goals

- Treat missing linked PR artifacts as a discovery problem, not an immediate blocker.
- Use the current branch and GitHub metadata to locate or create the PR.
- Wait for approvals and checks, then merge with the repo's normal GitHub flow.
- Only stop when merge is complete or a real external blocker remains.

## Preconditions

- `gh` CLI is available.
- You are on the branch that should be merged, or can determine it from the issue/PR context.

## Steps

1. Determine the current branch and working tree state.
2. Locate the PR using issue links, `gh pr view`, or `gh pr list --head <branch>`.
3. If no PR exists yet:
   - verify the branch is pushed,
   - create the PR,
   - attach/link it to the issue,
   - continue with the merge flow.
4. Confirm the PR is approved and required checks are green.
5. If the branch is behind or conflicting, sync with `origin/main`, resolve conflicts, rerun validation, and push.
6. Merge with the normal GitHub flow for the repo.
7. Move the issue to `Done` only after the merge is complete.

## Commands

```bash
branch=$(git branch --show-current)
pr_number=$(gh pr view --json number -q .number 2>/dev/null || true)

if [ -z "$pr_number" ]; then
  pr_number=$(gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null || true)
fi

if [ -z "$pr_number" ]; then
  # Ensure branch is pushed, then create the PR.
  git push -u origin "$branch"
  gh pr create
  pr_number=$(gh pr view --json number -q .number)
fi

mergeable=$(gh pr view "$pr_number" --json mergeable -q .mergeable)
checks=$(gh pr checks "$pr_number")
# If needed: resolve conflicts, wait for checks, and then merge.
```

## Failure Handling

- Missing linked PR artifacts are not blockers by themselves; discover or create the PR.
- If GitHub auth or permissions are missing, exhaust normal fallbacks first.
- If GitHub access still blocks progress after those fallbacks, move the issue back to `Human Review` with a concise blocker note in the workpad.
- Do not merge while human review feedback is still outstanding.
