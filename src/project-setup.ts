import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'dotenv';
import YAML from 'yaml';

import { normalizeCodexReasoningEffort } from './domain';
import type {
  DashboardSetupContext,
  ManagedProjectRecord,
  ProjectRuntimeControlInput,
  ProjectSetupInput,
  ProjectSetupResult,
  ProjectUpdateInput,
  WorkflowDefinition,
} from './domain';
import { ServiceError } from './errors';
import { loadWorkflowEnv } from './env';
import { readFatalProjectError } from './fatal-runtime-errors';
import { readGlobalConfig } from './global-config';
import { parseWorkflowFile } from './workflow';

const DEFAULT_PROJECT_PROMPT = `You are working on a Linear ticket \`{{ issue.identifier }}\`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Never call \`request_user_input\` or any equivalent human-input tool. Make the safest reasonable assumption, continue autonomously, and record blockers in the workpad when required.
3. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record it in the workpad and move the issue according to workflow.
4. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: Linear access is available

The agent should be able to talk to Linear, either via a configured Linear MCP server, injected \`linear_graphql\` tool, or direct API access using \`LINEAR_API_KEY\`. If none are present, stop and ask the user to configure Linear.

## Default posture

- Start by determining the ticket's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior/issue signal before changing code so the fix target is explicit.
- Keep ticket metadata current (state, checklist, acceptance criteria, links).
- Treat a single persistent Linear comment as the source of truth for progress.
- Use that single workpad comment for all progress and handoff notes; do not post separate "done"/summary comments.
- Treat any ticket-authored \`Validation\`, \`Test Plan\`, or \`Testing\` section as non-negotiable acceptance input: mirror it in the workpad and execute it before considering the work complete.
- When meaningful out-of-scope improvements are discovered during execution,
  file a separate Linear issue instead of expanding scope. The follow-up issue
  must include a clear title, description, and acceptance criteria, be placed in
  \`Backlog\`, be assigned to the same project as the current issue, link the
  current issue as \`related\`, and use \`blockedBy\` when the follow-up depends on
  the current issue.
- Move status only when the matching quality bar is met.
- Operate autonomously end-to-end unless blocked by missing requirements, secrets, or permissions.
- Use the blocked-access escape hatch only for true external blockers (missing required tools/auth) after exhausting documented fallbacks.

## Related skills

- \`linear\`: interact with Linear.
- \`commit\`: produce clean, logical commits during implementation.
- \`push\`: keep remote branch current and publish updates.
- \`pull\`: keep branch updated with latest \`origin/main\` before handoff.
- \`land\`: when ticket reaches \`Merging\`, prefer \`.codex/skills/land/SKILL.md\` if it exists. If the skill file is absent, use the fallback merge procedure in this workflow instead of blocking.

## Status map

- \`Backlog\` -> out of scope for this workflow; do not modify.
- \`Todo\` -> queued; immediately transition to \`In Progress\` before active work.
  - Special case: if a PR is already attached, treat as feedback/rework loop (run full PR feedback sweep, address or explicitly push back, revalidate, return to \`Human Review\`).
- \`In Progress\` -> implementation actively underway.
- \`Human Review\` -> PR is attached and validated; waiting on human approval.
- \`Merging\` -> approved by human; prefer the \`land\` skill when available, otherwise run the fallback merge procedure.
- \`Rework\` -> reviewer requested changes; planning + implementation required.
- \`Done\` -> terminal state; no further action required.

## Step 0: Determine current ticket state and route

1. Fetch the issue by explicit ticket ID.
2. Read the current state.
3. Route to the matching flow:
   - \`Backlog\` -> do not modify issue content/state; stop and wait for human to move it to \`Todo\`.
   - \`Todo\` -> immediately move to \`In Progress\`, then ensure bootstrap workpad comment exists (create if missing), then start execution flow.
     - If PR is already attached, start by reviewing all open PR comments and deciding required changes vs explicit pushback responses.
   - \`In Progress\` -> continue execution flow from current scratchpad comment.
   - \`Human Review\` -> wait and poll for decision/review updates.
   - \`Merging\` -> on entry, use \`.codex/skills/land/SKILL.md\` if present; otherwise run the fallback merge procedure. Missing skill files or missing linked PR artifacts are not blockers by themselves.
   - \`Rework\` -> run rework flow.
   - \`Done\` -> do nothing and shut down.
4. Check whether a PR already exists for the current branch and whether it is closed.
   - If a branch PR exists and is \`CLOSED\` or \`MERGED\`, treat prior branch work as non-reusable for this run.
   - Create a fresh branch from \`origin/main\` and restart execution flow as a new attempt.
5. For \`Todo\` tickets, do startup sequencing in this exact order:
   - \`update_issue(..., state: "In Progress")\`
   - find/create \`## Codex Workpad\` bootstrap comment
   - only then begin analysis/planning/implementation work.
6. Add a short comment if state and issue content are inconsistent, then proceed with the safest flow.

## Step 1: Start/continue execution (Todo or In Progress)

1. Find or create a single persistent scratchpad comment for the issue:
   - Search existing comments for a marker header: \`## Codex Workpad\`.
   - Ignore resolved comments while searching; only active/unresolved comments are eligible to be reused as the live workpad.
   - If found, reuse that comment; do not create a new workpad comment.
   - If not found, create one workpad comment and use it for all updates.
   - Persist the workpad comment ID and only write progress updates to that ID.
2. If arriving from \`Todo\`, do not delay on additional status transitions: the issue should already be \`In Progress\` before this step begins.
3. Immediately reconcile the workpad before new edits:
   - Check off items that are already done.
   - Expand/fix the plan so it is comprehensive for current scope.
   - Ensure \`Acceptance Criteria\` and \`Validation\` are current and still make sense for the task.
4. Start work by writing/updating a hierarchical plan in the workpad comment.
5. Ensure the workpad includes a compact environment stamp at the top as a code fence line:
   - Format: \`<host>:<abs-workdir>@<short-sha>\`
   - Example: \`devbox-01:/home/dev-user/code/symphony-workspaces/MT-32@7bdde33bc\`
   - Do not include metadata already inferable from Linear issue fields (\`issue ID\`, \`status\`, \`branch\`, \`PR link\`).
6. Add explicit acceptance criteria and TODOs in checklist form in the same comment.
   - If changes are user-facing, include a UI walkthrough acceptance criterion that describes the end-to-end user path to validate.
   - If changes touch app files or app behavior, add explicit app-specific flow checks to \`Acceptance Criteria\` in the workpad (for example: launch path, changed interaction path, and expected result path).
   - If the ticket description/comment context includes \`Validation\`, \`Test Plan\`, or \`Testing\` sections, copy those requirements into the workpad \`Acceptance Criteria\` and \`Validation\` sections as required checkboxes (no optional downgrade).
7. Run a principal-style self-review of the plan and refine it in the comment.
8. Before implementing, capture a concrete reproduction signal and record it in the workpad \`Notes\` section (command/output, screenshot, or deterministic UI behavior).
9. Run the \`pull\` skill to sync with latest \`origin/main\` before any code edits, then record the pull/sync result in the workpad \`Notes\`.
   - Include a \`pull skill evidence\` note with:
     - merge source(s),
     - result (\`clean\` or \`conflicts resolved\`),
     - resulting \`HEAD\` short SHA.
10. Compact context and proceed to execution.

## PR feedback sweep protocol (required)

When a ticket has an attached PR, run this protocol before moving to \`Human Review\`:

1. Identify the PR number from issue links/attachments.
2. Gather feedback from all channels:
   - Top-level PR comments (\`gh pr view --comments\`).
   - Inline review comments (\`gh api repos/<owner>/<repo>/pulls/<pr>/comments\`).
   - Review summaries/states (\`gh pr view --json reviews\`).
3. Treat every actionable reviewer comment (human or bot), including inline review comments, as blocking until one of these is true:
   - code/test/docs updated to address it, or
   - explicit, justified pushback reply is posted on that thread.
4. Update the workpad plan/checklist to include each feedback item and its resolution status.
5. Re-run validation after feedback-driven changes and push updates.
6. Repeat this sweep until there are no outstanding actionable comments.

## Blocked-access escape hatch (required behavior)

Use this only when completion is blocked by missing required tools or missing auth/permissions that cannot be resolved in-session.

- GitHub is **not** a valid blocker by default. Always try fallback strategies first (alternate remote/auth mode, then continue publish/review flow).
- Do not move to \`Human Review\` for GitHub access/auth until all fallback strategies have been attempted and documented in the workpad.
- If a non-GitHub required tool is missing, or required non-GitHub auth is unavailable, move the ticket to \`Human Review\` with a short blocker brief in the workpad that includes:
  - what is missing,
  - why it blocks required acceptance/validation,
  - exact human action needed to unblock.
- Keep the brief concise and action-oriented; do not add extra top-level comments outside the workpad.

## Step 2: Execution phase (Todo -> In Progress -> Human Review)

1. Determine current repo state (\`branch\`, \`git status\`, \`HEAD\`) and verify the kickoff \`pull\` sync result is already recorded in the workpad before implementation continues.
2. If current issue state is \`Todo\`, move it to \`In Progress\`; otherwise leave the current state unchanged.
3. Load the existing workpad comment and treat it as the active execution checklist.
   - Edit it liberally whenever reality changes (scope, risks, validation approach, discovered tasks).
4. Implement against the hierarchical TODOs and keep the comment current:
   - Check off completed items.
   - Add newly discovered items in the appropriate section.
   - Keep parent/child structure intact as scope evolves.
   - Update the workpad immediately after each meaningful milestone (for example: reproduction complete, code change landed, validation run, review feedback addressed).
   - Never leave completed work unchecked in the plan.
   - For tickets that started as \`Todo\` with an attached PR, run the full PR feedback sweep protocol immediately after kickoff and before new feature work.
5. Run validation/tests required for the scope.
   - Mandatory gate: execute all ticket-provided \`Validation\`/\`Test Plan\`/\`Testing\` requirements when present; treat unmet items as incomplete work.
   - Prefer a targeted proof that directly demonstrates the behavior you changed.
   - You may make temporary local proof edits to validate assumptions (for example: tweak a local build input for \`make\`, or hardcode a UI account / response path) when this increases confidence.
   - Revert every temporary proof edit before commit/push.
   - Document these temporary proof steps and outcomes in the workpad \`Validation\`/\`Notes\` sections so reviewers can follow the evidence.
   - If app-touching, run \`launch-app\` validation and capture/upload media via \`github-pr-media\` before handoff.
6. Re-check all acceptance criteria and close any gaps.
7. Before every \`git push\` attempt, run the required validation for your scope and confirm it passes; if it fails, address issues and rerun until green, then commit and push changes.
8. Attach PR URL to the issue (prefer attachment; use the workpad comment only if attachment is unavailable).
   - Ensure the GitHub PR has label \`symphony\` (add it if missing).
9. Merge latest \`origin/main\` into branch, resolve conflicts, and rerun checks.
10. Update the workpad comment with final checklist status and validation notes.
    - Mark completed plan/acceptance/validation checklist items as checked.
    - Add final handoff notes (commit + validation summary) in the same workpad comment.
    - Do not include PR URL in the workpad comment; keep PR linkage on the issue via attachment/link fields.
    - Add a short \`### Confusions\` section at the bottom when any part of task execution was unclear/confusing, with concise bullets.
    - Do not post any additional completion summary comment.
11. Before moving to \`Human Review\`, poll PR feedback and checks:
    - Read the PR \`Manual QA Plan\` comment (when present) and use it to sharpen UI/runtime test coverage for the current change.
    - Run the full PR feedback sweep protocol.
    - Confirm PR checks are passing (green) after the latest changes.
    - Confirm every required ticket-provided validation/test-plan item is explicitly marked complete in the workpad.
    - Repeat this check-address-verify loop until no outstanding comments remain and checks are fully passing.
    - Re-open and refresh the workpad before state transition so \`Plan\`, \`Acceptance Criteria\`, and \`Validation\` exactly match completed work.
12. Only then move issue to \`Human Review\`.
    - Exception: if blocked by missing required non-GitHub tools/auth per the blocked-access escape hatch, move to \`Human Review\` with the blocker brief and explicit unblock actions.
13. For \`Todo\` tickets that already had a PR attached at kickoff:
    - Ensure all existing PR feedback was reviewed and resolved, including inline review comments (code changes or explicit, justified pushback response).
    - Ensure branch was pushed with any required updates.
    - Then move to \`Human Review\`.

## Step 3: Human Review and merge handling

1. When the issue is in \`Human Review\`, do not code or change ticket content.
2. Poll for updates as needed, including GitHub PR review comments from humans and bots.
3. If review feedback requires changes, move the issue to \`Rework\` and follow the rework flow.
4. If approved, human moves the issue to \`Merging\`.
5. When the issue is in \`Merging\`, use \`.codex/skills/land/SKILL.md\` if present; otherwise execute the fallback merge procedure below.
6. Fallback merge procedure when the \`land\` skill is unavailable:
   - Discover the PR from issue links, branch metadata, \`gh pr view\`, or \`gh pr list\`; absence of pre-linked PR artifacts is not itself a blocker.
   - If no PR exists yet, push the branch, create the PR, attach/link it to the issue, and continue.
   - Confirm approvals and required checks are green, then merge with the normal GitHub flow for the repo.
   - If GitHub auth or repo permissions are still missing after exhausting documented fallbacks, move the issue back to \`Human Review\` with a concise blocker note in the workpad.
7. After merge is complete, move the issue to \`Done\`.

## Step 4: Rework handling

1. Treat \`Rework\` as a full approach reset, not incremental patching.
2. Re-read the full issue body and all human comments; explicitly identify what will be done differently this attempt.
3. Close the existing PR tied to the issue.
4. Remove the existing \`## Codex Workpad\` comment from the issue.
5. Create a fresh branch from \`origin/main\`.
6. Start over from the normal kickoff flow:
   - If current issue state is \`Todo\`, move it to \`In Progress\`; otherwise keep the current state.
   - Create a new bootstrap \`## Codex Workpad\` comment.
   - Build a fresh plan/checklist and execute end-to-end.

## Completion bar before Human Review

- Step 1/2 checklist is fully complete and accurately reflected in the single workpad comment.
- Acceptance criteria and required ticket-provided validation items are complete.
- Validation/tests are green for the latest commit.
- PR feedback sweep is complete and no actionable comments remain.
- PR checks are green, branch is pushed, and PR is linked on the issue.
- Required PR metadata is present (\`symphony\` label).
- If app-touching, runtime validation/media requirements from \`App runtime validation (required)\` are complete.

## Guardrails

- If the branch PR is already closed/merged, do not reuse that branch or prior implementation state for continuation.
- For closed/merged branch PRs, create a new branch from \`origin/main\` and restart from reproduction/planning as if starting fresh.
- If issue state is \`Backlog\`, do not modify it; wait for human to move to \`Todo\`.
- Do not edit the issue body/description for planning or progress tracking.
- Use exactly one persistent workpad comment (\`## Codex Workpad\`) per issue.
- If comment editing is unavailable in-session, use the update script. Only report blocked if both MCP editing and script-based editing are unavailable.
- Temporary proof edits are allowed only for local verification and must be reverted before commit.
- If out-of-scope improvements are found, create a separate Backlog issue rather
  than expanding current scope, and include a clear
  title/description/acceptance criteria, same-project assignment, a \`related\`
  link to the current issue, and \`blockedBy\` when the follow-up depends on the
  current issue.
- Do not move to \`Human Review\` unless the \`Completion bar before Human Review\` is satisfied.
- In \`Human Review\`, do not make changes; wait and poll.
- If state is terminal (\`Done\`), do nothing and shut down.
- Keep issue text concise, specific, and reviewer-oriented.
- If blocked and no workpad exists yet, add one blocker comment describing blocker, impact, and next unblock action.

## Workpad template

Use this exact structure for the persistent workpad comment and keep it updated in place throughout execution:

\`\`\`\`md
## Codex Workpad

\`\`\`text
<hostname>:<abs-path>@<short-sha>
\`\`\`

### Plan

- [ ] 1\\. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2\\. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: \`<command>\`

### Notes

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
\`\`\`\``;

const DEFAULT_AGENT_PROVIDER = 'codex';
const DEFAULT_GROK_MODEL = 'grok-code-fast-1';
const DEFAULT_CODEX_COMMAND =
  'codex --config shell_environment_policy.inherit=all app-server';
const DEFAULT_CLAUDE_COMMAND = 'claude';
const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

type ProjectSecrets = {
  LINEAR_API_KEY?: string;
  XAI_API_KEY?: string;
  PROJECT_SLUG?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_TOKEN?: string;
};

export async function createProjectSetup(
  projectsRoot: string,
  input: ProjectSetupInput,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ProjectSetupResult> {
  const globalConfig = await readGlobalConfig(projectsRoot, baseEnv);
  const normalized = normalizeProjectSetupInput(input, globalConfig);
  const workflowDirectory = path.resolve(projectsRoot, sanitizeProjectDirectory(normalized.projectSlug));
  const workflowPath = path.join(workflowDirectory, 'WORKFLOW.md');
  const envFilePath = path.join(workflowDirectory, '.env.local');

  await ensureProjectDirectoryAvailable(workflowDirectory);
  await mkdir(workflowDirectory, { recursive: true });

  await writeFile(workflowPath, renderWorkflowMarkdown(normalized), "utf8");
  await writeProjectSecrets(envFilePath, {
    PROJECT_SLUG: normalized.projectSlug,
    GITHUB_REPOSITORY: normalized.githubRepository,
    ...(normalized.useGlobalLinearApiKey ? {} : { LINEAR_API_KEY: normalized.linearApiKey ?? undefined }),
    ...(normalized.useGlobalXaiApiKey ? {} : { XAI_API_KEY: normalized.xaiApiKey ?? undefined }),
    ...(normalized.useGlobalGithubToken ? {} : { GITHUB_TOKEN: normalized.githubToken ?? undefined }),
  });

  const record = await readProjectSetup(workflowPath, baseEnv, projectsRoot);
  return {
    ...record,
    githubRepository: normalized.githubRepository,
  };
}

export async function listProjectSetups(
  workflowPaths: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string,
): Promise<ManagedProjectRecord[]> {
  const projects = await Promise.all(
    workflowPaths.map((workflowPath) => readProjectSetup(workflowPath, baseEnv, projectsRoot)),
  );
  return projects.sort((left, right) => visibleProjectName(left).localeCompare(visibleProjectName(right)));
}

export async function readProjectSetup(
  workflowPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string,
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, 'utf8');
  const workflow = parseWorkflowFile(workflowContent);
  const root = asObject(workflow.config);
  const project = asObject(root.project);
  const polling = asObject(root.polling);
  const agent = asObject(root.agent);
  const envFilePath = path.join(path.dirname(absoluteWorkflowPath), '.env.local');
  const localEnv = await readProjectSecrets(envFilePath);
  const resolvedProjectsRoot = resolveProjectsRoot(absoluteWorkflowPath, projectsRoot);
  const globalConfig = await readGlobalConfig(resolvedProjectsRoot, baseEnv);
  const fatalError = await readFatalProjectError(absoluteWorkflowPath);
  const effectiveEnv = await loadWorkflowEnv(
    path.dirname(absoluteWorkflowPath),
    baseEnv,
    undefined,
    resolvedProjectsRoot,
  );
  const trackerConfig = asObject(root.tracker);
  const hooksConfig = asObject(root.hooks);
  const projectSlug =
    typeof localEnv.PROJECT_SLUG === 'string'
      ? localEnv.PROJECT_SLUG
      : typeof effectiveEnv.PROJECT_SLUG === 'string'
        ? effectiveEnv.PROJECT_SLUG
        : typeof trackerConfig.project_slug === 'string'
          ? trackerConfig.project_slug
          : '';
  const githubRepository =
    typeof localEnv.GITHUB_REPOSITORY === 'string'
      ? localEnv.GITHUB_REPOSITORY
      : typeof effectiveEnv.GITHUB_REPOSITORY === 'string'
        ? effectiveEnv.GITHUB_REPOSITORY
        : typeof hooksConfig.github_repository === 'string'
          ? hooksConfig.github_repository
          : null;
  const usesGlobalLinearApiKey = !(typeof localEnv.LINEAR_API_KEY === 'string' && localEnv.LINEAR_API_KEY.length > 0);
  const usesGlobalXaiApiKey = !(typeof localEnv.XAI_API_KEY === 'string' && localEnv.XAI_API_KEY.length > 0);
  const usesGlobalGithubToken = !(typeof localEnv.GITHUB_TOKEN === 'string' && localEnv.GITHUB_TOKEN.length > 0);
  const usesGlobalPollingIntervalMs = !hasOwnValue(polling.interval_ms);
  const usesGlobalMaxConcurrentAgents = !hasOwnValue(agent.max_concurrent_agents);
  const runtimeConfig = asObject(root.runtime);
  const codexConfig = asObject(root.codex);
  const claudeConfig = asObject(root.claude);
  const grokConfig = asObject(root.grok);
  const configuredProvider = normalizeAgentProvider(runtimeConfig.provider);
  const usesGlobalAgentProvider = !configuredProvider;
  const agentProvider = configuredProvider ?? globalConfig.defaults.agentProvider;
  const configuredModel =
    typeof runtimeConfig.model === 'string' && runtimeConfig.model.trim().length > 0
      ? runtimeConfig.model.trim()
      : agentProvider === 'claude' && typeof claudeConfig.model === 'string' && claudeConfig.model.trim().length > 0
        ? claudeConfig.model.trim()
        : agentProvider === 'grok' && typeof grokConfig.model === 'string' && grokConfig.model.trim().length > 0
          ? grokConfig.model.trim()
        : typeof codexConfig.model === 'string' && codexConfig.model.trim().length > 0
          ? codexConfig.model.trim()
          : '';
  const usesGlobalAgentModel = !configuredModel.length;
  const effectiveUsesGlobalAgentModel = usesGlobalAgentModel && !(agentProvider === 'grok' && !globalConfig.defaults.agentModel);
  const configuredCodexReasoningEffort =
    normalizeCodexReasoningEffort(codexConfig.reasoning_effort);
  const usesGlobalCodexReasoningEffort = configuredCodexReasoningEffort === null;

  return {
    id: absoluteWorkflowPath,
    displayName: typeof project.name === 'string' && project.name.trim().length > 0 ? project.name.trim() : null,
    enabled: coerceBoolean(project.enabled, true),
    runtimeRunning: false,
    fatalError,
    projectSlug,
    githubRepository,
    workflowDirectory: path.dirname(absoluteWorkflowPath),
    workflowPath: absoluteWorkflowPath,
    envFilePath,
    pollingIntervalMs: usesGlobalPollingIntervalMs
      ? globalConfig.defaults.pollingIntervalMs
      : coercePositiveInteger(polling.interval_ms, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: usesGlobalMaxConcurrentAgents
      ? globalConfig.defaults.maxConcurrentAgents
      : coercePositiveInteger(agent.max_concurrent_agents, globalConfig.defaults.maxConcurrentAgents),
    hasLinearApiKey: usesGlobalLinearApiKey
      ? globalConfig.hasLinearApiKey
      : typeof localEnv.LINEAR_API_KEY === 'string' && localEnv.LINEAR_API_KEY.length > 0,
    hasXaiApiKey: usesGlobalXaiApiKey
      ? globalConfig.hasXaiApiKey
      : typeof localEnv.XAI_API_KEY === 'string' && localEnv.XAI_API_KEY.length > 0,
    hasGithubToken: usesGlobalGithubToken
      ? globalConfig.hasGithubToken
      : typeof localEnv.GITHUB_TOKEN === 'string' && localEnv.GITHUB_TOKEN.length > 0,
    agentProvider,
    agentModel: effectiveUsesGlobalAgentModel
      ? globalConfig.defaults.agentModel
      : configuredModel || (agentProvider === 'grok' ? DEFAULT_GROK_MODEL : ''),
    codexReasoningEffort: usesGlobalCodexReasoningEffort
      ? globalConfig.defaults.codexReasoningEffort
      : configuredCodexReasoningEffort,
    usesGlobalAgentProvider,
    usesGlobalAgentModel: effectiveUsesGlobalAgentModel,
    usesGlobalCodexReasoningEffort,
    usesGlobalLinearApiKey,
    usesGlobalXaiApiKey,
    usesGlobalGithubToken,
    usesGlobalPollingIntervalMs,
    usesGlobalMaxConcurrentAgents,
  };
}

export async function updateProjectSetup(
  workflowPath: string,
  input: ProjectUpdateInput,
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string,
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, 'utf8');
  const definition = parseWorkflowFile(workflowContent);
  const root = asObject(definition.config);
  const resolvedProjectsRoot = resolveProjectsRoot(absoluteWorkflowPath, projectsRoot);
  const globalConfig = await readGlobalConfig(resolvedProjectsRoot, baseEnv);
  const normalized = normalizeProjectUpdateInput(input, globalConfig);
  const currentRecord = await readProjectSetup(absoluteWorkflowPath, baseEnv, resolvedProjectsRoot);
  const currentSecrets = await readProjectSecrets(currentRecord.envFilePath);

  setNestedString(root, ['tracker', 'kind'], 'linear');
  setNestedString(root, ['tracker', 'api_key'], '$LINEAR_API_KEY');
  setNestedString(root, ['tracker', 'project_slug'], '$PROJECT_SLUG');
  setNestedString(root, ['workspace', 'root'], '.orchestrai/workspaces');
  setNestedString(root, ['codex', 'command'], DEFAULT_CODEX_COMMAND);
  setNestedString(root, ['codex', 'reasoning_effort'], globalConfig.defaults.codexReasoningEffort);
  setNestedString(root, ['codex', 'approval_policy'], 'never');
  setNestedString(root, ['codex', 'thread_sandbox'], 'danger-full-access');
  setNestedValue(root, ['codex', 'turn_sandbox_policy'], {
    type: 'dangerFullAccess',
  });
  setNestedString(root, ['claude', 'command'], DEFAULT_CLAUDE_COMMAND);
  setNestedString(root, ['claude', 'permission_mode'], 'bypassPermissions');
  setNestedString(root, ['grok', 'api_key'], '$XAI_API_KEY');
  setNestedString(root, ['grok', 'base_url'], DEFAULT_GROK_BASE_URL);
  setNestedNumber(root, ['grok', 'max_tool_rounds'], 24);
  setNestedNumber(root, ['grok', 'command_timeout_ms'], 120000);
  setNestedString(root, ['hooks', 'timeout_ms'], '60000');
  setNestedString(root, ['server', 'port'], '-1');

  const projectConfig = ensureObject(root, 'project');
  projectConfig.enabled = currentRecord.enabled;
  if (normalized.displayName) {
    projectConfig.name = normalized.displayName;
  } else {
    delete projectConfig.name;
  }
  if (normalized.useGlobalPollingIntervalMs) {
    deleteNestedValue(root, ['polling', 'interval_ms']);
  } else {
    setNestedNumber(
      root,
      ['polling', 'interval_ms'],
      normalized.pollingIntervalMs ?? globalConfig.defaults.pollingIntervalMs,
    );
  }
  if (normalized.useGlobalMaxConcurrentAgents) {
    deleteNestedValue(root, ['agent', 'max_concurrent_agents']);
  } else {
    setNestedNumber(
      root,
      ['agent', 'max_concurrent_agents'],
      normalized.maxConcurrentAgents ?? globalConfig.defaults.maxConcurrentAgents,
    );
  }
  if (normalized.useGlobalAgentProvider) {
    deleteNestedValue(root, ['runtime', 'provider']);
  } else {
    setNestedString(root, ['runtime', 'provider'], normalized.agentProvider);
  }
  if (normalized.useGlobalAgentModel) {
    deleteNestedValue(root, ['runtime', 'model']);
    deleteNestedValue(root, ['codex', 'model']);
    deleteNestedValue(root, ['claude', 'model']);
  } else if (normalized.agentModel) {
    setNestedString(root, ['runtime', 'model'], normalized.agentModel);
    deleteNestedValue(root, ['codex', 'model']);
    deleteNestedValue(root, ['claude', 'model']);
  }
  if (normalized.useGlobalCodexReasoningEffort) {
    deleteNestedValue(root, ['codex', 'reasoning_effort']);
  } else {
    setNestedString(root, ['codex', 'reasoning_effort'], normalized.codexReasoningEffort);
  }

  await writeWorkflowDefinition(absoluteWorkflowPath, {
    config: root,
    prompt_template: definition.prompt_template.trim().length > 0 ? definition.prompt_template : DEFAULT_PROJECT_PROMPT,
  });

  const nextSecrets: ProjectSecrets = {
    ...currentSecrets,
    PROJECT_SLUG: normalized.projectSlug,
    GITHUB_REPOSITORY: normalized.githubRepository,
  };

  if (normalized.useGlobalLinearApiKey) {
    delete nextSecrets.LINEAR_API_KEY;
  } else if (normalized.linearApiKey) {
    nextSecrets.LINEAR_API_KEY = normalized.linearApiKey;
  }
  if (normalized.useGlobalXaiApiKey) {
    delete nextSecrets.XAI_API_KEY;
  } else if (normalized.xaiApiKey) {
    nextSecrets.XAI_API_KEY = normalized.xaiApiKey;
  }
  if (normalized.useGlobalGithubToken) {
    delete nextSecrets.GITHUB_TOKEN;
  } else if (normalized.githubToken) {
    nextSecrets.GITHUB_TOKEN = normalized.githubToken;
  }

  await writeProjectSecrets(currentRecord.envFilePath, nextSecrets);

  const desiredDirectory = path.resolve(
    path.dirname(currentRecord.workflowDirectory),
    sanitizeProjectDirectory(normalized.projectSlug),
  );
  let finalWorkflowPath = absoluteWorkflowPath;
  if (desiredDirectory !== currentRecord.workflowDirectory) {
    await ensureProjectDirectoryAvailable(desiredDirectory);
    await rename(currentRecord.workflowDirectory, desiredDirectory);
    finalWorkflowPath = path.join(desiredDirectory, 'WORKFLOW.md');
  }

  return readProjectSetup(finalWorkflowPath, baseEnv, resolvedProjectsRoot);
}

export async function setProjectEnabled(
  workflowPath: string,
  input: ProjectRuntimeControlInput & { enabled: boolean },
  baseEnv: NodeJS.ProcessEnv = process.env,
  projectsRoot?: string,
): Promise<ManagedProjectRecord> {
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const workflowContent = await readFile(absoluteWorkflowPath, 'utf8');
  const definition = parseWorkflowFile(workflowContent);
  const root = asObject(definition.config);
  const normalized = normalizeProjectRuntimeControlInput(input);
  const projectConfig = ensureObject(root, 'project');
  projectConfig.enabled = normalized.enabled;

  await writeWorkflowDefinition(absoluteWorkflowPath, {
    config: root,
    prompt_template: definition.prompt_template.trim().length > 0 ? definition.prompt_template : DEFAULT_PROJECT_PROMPT,
  });

  return readProjectSetup(absoluteWorkflowPath, baseEnv, projectsRoot);
}

export async function removeProjectSetup(workflowPath: string): Promise<void> {
  const record = await readProjectSetup(workflowPath);
  await rm(record.workflowDirectory, { recursive: true, force: true });
}

export function createDashboardSetupContext(projectsRoot: string): DashboardSetupContext {
  return {
    projectsRoot: path.resolve(projectsRoot),
    trackerKind: 'linear',
    repositoryProvider: 'github',
    globalConfig: {
      projectsRoot: path.resolve(projectsRoot),
      envFilePath: path.join(path.resolve(projectsRoot), '.env.local'),
      defaults: {
        pollingIntervalMs: DEFAULT_POLL_INTERVAL_MS,
        maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
        agentProvider: DEFAULT_AGENT_PROVIDER,
        agentModel: '',
        codexReasoningEffort: 'medium',
      },
      hasLinearApiKey: false,
      hasXaiApiKey: false,
      hasGithubToken: false,
    },
  };
}

export function visibleProjectName(project: Pick<ManagedProjectRecord, 'displayName' | 'projectSlug'>): string {
  return project.displayName ?? project.projectSlug;
}

function renderWorkflowMarkdown(input: {
  displayName: string | null;
  pollingIntervalMs: number | null;
  maxConcurrentAgents: number | null;
  useGlobalPollingIntervalMs: boolean;
  useGlobalMaxConcurrentAgents: boolean;
  agentProvider: string;
  agentModel: string | null;
  codexReasoningEffort: string;
  useGlobalAgentProvider: boolean;
  useGlobalAgentModel: boolean;
  useGlobalCodexReasoningEffort: boolean;
}): string {
  const frontMatter: Record<string, unknown> = {
    tracker: {
      kind: 'linear',
      api_key: '$LINEAR_API_KEY',
      project_slug: '$PROJECT_SLUG',
      active_states: ['Todo', 'In Progress', 'Human Review', 'Merging', 'Rework'],
      terminal_states: ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate'],
    },
    workspace: {
      root: '.orchestrai/workspaces',
    },
    hooks: {
      timeout_ms: 60000,
      after_create: [
        'set -euo pipefail',
        'if [[ -n "${GITHUB_TOKEN:-}" ]]; then',
        '  git clone "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" repo',
        'else',
        '  git clone "git@github.com:${GITHUB_REPOSITORY}.git" repo || git clone "https://github.com/${GITHUB_REPOSITORY}.git" repo',
        'fi',
      ].join('\n'),
    },
    agent: {
      max_turns: 20,
      max_retry_backoff_ms: 300000,
    },
    runtime: {},
    codex: {
      command: DEFAULT_CODEX_COMMAND,
      reasoning_effort: input.useGlobalCodexReasoningEffort ? undefined : input.codexReasoningEffort,
      approval_policy: 'never',
      thread_sandbox: 'danger-full-access',
      turn_sandbox_policy: {
        type: 'dangerFullAccess',
      },
    },
    claude: {
      command: DEFAULT_CLAUDE_COMMAND,
      permission_mode: 'bypassPermissions',
    },
    grok: {
      api_key: '$XAI_API_KEY',
      base_url: DEFAULT_GROK_BASE_URL,
      max_tool_rounds: 24,
      command_timeout_ms: 120000,
    },
    server: {
      port: -1,
    },
  };

  frontMatter.project = {
    enabled: true,
    ...(input.displayName ? { name: input.displayName } : {}),
  };
  if (!input.useGlobalPollingIntervalMs && input.pollingIntervalMs) {
    frontMatter.polling = {
      interval_ms: input.pollingIntervalMs,
    };
  }
  if (!input.useGlobalMaxConcurrentAgents && input.maxConcurrentAgents) {
    const agentConfig = asObject(frontMatter.agent);
    agentConfig.max_concurrent_agents = input.maxConcurrentAgents;
  }
  if (!input.useGlobalAgentProvider) {
    const runtimeConfig = asObject(frontMatter.runtime);
    runtimeConfig.provider = input.agentProvider;
  }
  if (!input.useGlobalAgentModel && input.agentModel) {
    const runtimeConfig = asObject(frontMatter.runtime);
    runtimeConfig.model = input.agentModel;
  }
  if (Object.keys(asObject(frontMatter.runtime)).length === 0) {
    delete frontMatter.runtime;
  }

  return `---\n${YAML.stringify(frontMatter)}---\n${DEFAULT_PROJECT_PROMPT}\n`;
}

async function ensureProjectDirectoryAvailable(workflowDirectory: string): Promise<void> {
  const existing = await stat(workflowDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (existing) {
    throw new ServiceError('workflow_exists', 'A project workflow with this slug already exists', {
      workflow_directory: workflowDirectory,
    });
  }
}

async function readProjectSecrets(filePath: string): Promise<ProjectSecrets> {
  const content = await readFile(filePath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  return parse(content);
}

async function writeProjectSecrets(filePath: string, secrets: ProjectSecrets): Promise<void> {
  const lines = Object.entries(secrets)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeWorkflowDefinition(filePath: string, definition: WorkflowDefinition): Promise<void> {
  await writeFile(
    filePath,
    `---\n${YAML.stringify(definition.config)}---\n${definition.prompt_template.trim()}\n`,
    'utf8',
  );
}

function normalizeProjectSetupInput(
  input: ProjectSetupInput,
  globalConfig: Awaited<ReturnType<typeof readGlobalConfig>>,
) {
  const requestedAgentProvider = normalizeAgentProvider(input.agentProvider);
  const requestedAgentModel = normalizeOptionalValue(input.agentModel);
  const requestedCodexReasoningEffort = normalizeCodexReasoningEffort(input.codexReasoningEffort);
  if (
    typeof input.codexReasoningEffort === 'string' &&
    input.codexReasoningEffort.trim().length > 0 &&
    requestedCodexReasoningEffort === null
  ) {
    throw new ServiceError(
      'invalid_project_setup',
      'codexReasoningEffort must be low, medium, high, or xhigh',
    );
  }
  const useGlobalAgentProvider =
    input.useGlobalAgentProvider === true || (input.useGlobalAgentProvider === undefined && !requestedAgentProvider);
  const requestedUseGlobalAgentModel =
    input.useGlobalAgentModel === true || (input.useGlobalAgentModel === undefined && !requestedAgentModel);
  const useGlobalCodexReasoningEffort =
    input.useGlobalCodexReasoningEffort !== false &&
    (input.useGlobalCodexReasoningEffort === true || requestedCodexReasoningEffort === null);
  const useGlobalLinearApiKey =
    input.useGlobalLinearApiKey === true ||
    (!normalizeOptionalValue(input.linearApiKey) && globalConfig.hasLinearApiKey);
  const useGlobalXaiApiKey =
    input.useGlobalXaiApiKey === true || (!normalizeOptionalValue(input.xaiApiKey) && globalConfig.hasXaiApiKey);
  const useGlobalGithubToken = input.useGlobalGithubToken === true || !normalizeOptionalValue(input.githubToken);
  const useGlobalPollingIntervalMs = input.useGlobalPollingIntervalMs !== false;
  const useGlobalMaxConcurrentAgents = input.useGlobalMaxConcurrentAgents !== false;
  const linearApiKey = normalizeOptionalValue(input.linearApiKey);
  const xaiApiKey = normalizeOptionalValue(input.xaiApiKey);

  if (!useGlobalLinearApiKey && !linearApiKey) {
    throw new ServiceError(
      'invalid_project_setup',
      'linearApiKey is required when no global Linear API key is configured',
    );
  }

  const resolvedAgentProvider = useGlobalAgentProvider ? globalConfig.defaults.agentProvider : requestedAgentProvider ?? DEFAULT_AGENT_PROVIDER;
  const fallbackAgentModel =
    resolvedAgentProvider === 'grok' ? globalConfig.defaults.agentModel || DEFAULT_GROK_MODEL : globalConfig.defaults.agentModel;
  const useGlobalAgentModel = requestedUseGlobalAgentModel && !(resolvedAgentProvider === 'grok' && !globalConfig.defaults.agentModel);
  if (resolvedAgentProvider === 'grok' && !useGlobalXaiApiKey && !xaiApiKey) {
    throw new ServiceError(
      'invalid_project_setup',
      'xaiApiKey is required when Grok is selected and no global XAI API key is configured',
    );
  }
  if (resolvedAgentProvider === 'grok' && useGlobalXaiApiKey && !globalConfig.hasXaiApiKey) {
    throw new ServiceError(
      'invalid_project_setup',
      'A global XAI API key is required when Grok is selected with inherited XAI credentials',
    );
  }

  return {
    displayName: normalizeOptionalValue(input.displayName),
    projectSlug: normalizeRequiredValue(input.projectSlug, 'projectSlug'),
    linearApiKey,
    xaiApiKey,
    githubRepository: normalizeGitHubRepository(input.githubRepository),
    githubToken: normalizeOptionalValue(input.githubToken),
    pollingIntervalMs: useGlobalPollingIntervalMs
      ? null
      : coercePositiveInteger(input.pollingIntervalMs, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: useGlobalMaxConcurrentAgents
      ? null
      : coercePositiveInteger(input.maxConcurrentAgents, globalConfig.defaults.maxConcurrentAgents),
    agentProvider: resolvedAgentProvider,
    agentModel: useGlobalAgentModel ? fallbackAgentModel : requestedAgentModel ?? (resolvedAgentProvider === 'grok' ? DEFAULT_GROK_MODEL : null),
    codexReasoningEffort: useGlobalCodexReasoningEffort
      ? globalConfig.defaults.codexReasoningEffort
      : requestedCodexReasoningEffort ?? globalConfig.defaults.codexReasoningEffort,
    useGlobalAgentProvider,
    useGlobalAgentModel,
    useGlobalCodexReasoningEffort,
    useGlobalLinearApiKey,
    useGlobalXaiApiKey,
    useGlobalGithubToken,
    useGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents,
  };
}

function normalizeProjectUpdateInput(
  input: ProjectUpdateInput,
  globalConfig: Awaited<ReturnType<typeof readGlobalConfig>>,
) {
  const useGlobalAgentProvider = input.useGlobalAgentProvider === true;
  const requestedUseGlobalAgentModel = input.useGlobalAgentModel === true;
  const useGlobalCodexReasoningEffort = input.useGlobalCodexReasoningEffort === true;
  const useGlobalLinearApiKey = input.useGlobalLinearApiKey === true;
  const useGlobalXaiApiKey = input.useGlobalXaiApiKey === true;
  const useGlobalGithubToken = input.useGlobalGithubToken === true;
  const useGlobalPollingIntervalMs = input.useGlobalPollingIntervalMs === true;
  const useGlobalMaxConcurrentAgents = input.useGlobalMaxConcurrentAgents === true;
  const resolvedAgentProvider =
    useGlobalAgentProvider ? globalConfig.defaults.agentProvider : normalizeAgentProvider(input.agentProvider) ?? DEFAULT_AGENT_PROVIDER;
  const useGlobalAgentModel = requestedUseGlobalAgentModel && !(resolvedAgentProvider === 'grok' && !globalConfig.defaults.agentModel);
  const xaiApiKey = normalizeOptionalValue(input.xaiApiKey);
  const requestedCodexReasoningEffort = normalizeCodexReasoningEffort(input.codexReasoningEffort);

  if (
    typeof input.codexReasoningEffort === 'string' &&
    input.codexReasoningEffort.trim().length > 0 &&
    requestedCodexReasoningEffort === null
  ) {
    throw new ServiceError(
      'invalid_project_setup',
      'codexReasoningEffort must be low, medium, high, or xhigh',
    );
  }

  if (resolvedAgentProvider === 'grok' && !useGlobalXaiApiKey && !xaiApiKey) {
    throw new ServiceError(
      'invalid_project_setup',
      'xaiApiKey is required when Grok is selected and no global XAI API key is configured',
    );
  }
  if (resolvedAgentProvider === 'grok' && useGlobalXaiApiKey && !globalConfig.hasXaiApiKey) {
    throw new ServiceError(
      'invalid_project_setup',
      'A global XAI API key is required when Grok is selected with inherited XAI credentials',
    );
  }

  return {
    id: normalizeRequiredValue(input.id, 'id'),
    displayName: normalizeOptionalValue(input.displayName),
    projectSlug: normalizeRequiredValue(input.projectSlug, 'projectSlug'),
    githubRepository: normalizeGitHubRepository(input.githubRepository),
    linearApiKey: normalizeOptionalValue(input.linearApiKey),
    xaiApiKey,
    githubToken: normalizeOptionalValue(input.githubToken),
    agentProvider: resolvedAgentProvider,
    agentModel: useGlobalAgentModel ? null : normalizeOptionalValue(input.agentModel) ?? (resolvedAgentProvider === 'grok' ? DEFAULT_GROK_MODEL : null),
    codexReasoningEffort: useGlobalCodexReasoningEffort
      ? globalConfig.defaults.codexReasoningEffort
      : requestedCodexReasoningEffort ?? globalConfig.defaults.codexReasoningEffort,
    pollingIntervalMs: useGlobalPollingIntervalMs
      ? null
      : coercePositiveInteger(input.pollingIntervalMs, globalConfig.defaults.pollingIntervalMs),
    maxConcurrentAgents: useGlobalMaxConcurrentAgents
      ? null
      : coercePositiveInteger(input.maxConcurrentAgents, globalConfig.defaults.maxConcurrentAgents),
    useGlobalLinearApiKey,
    useGlobalXaiApiKey,
    useGlobalGithubToken,
    useGlobalAgentProvider,
    useGlobalAgentModel,
    useGlobalCodexReasoningEffort,
    useGlobalPollingIntervalMs,
    useGlobalMaxConcurrentAgents,
  };
}

function normalizeProjectRuntimeControlInput(input: ProjectRuntimeControlInput & { enabled: boolean }) {
  return {
    id: normalizeRequiredValue(input.id, 'id'),
    enabled: Boolean(input.enabled),
  };
}

function resolveProjectsRoot(workflowPath: string, projectsRoot?: string): string {
  if (projectsRoot) {
    return path.resolve(projectsRoot);
  }

  return path.resolve(path.dirname(path.dirname(workflowPath)));
}

function normalizeGitHubRepository(value: string): string {
  const trimmed = normalizeRequiredValue(value, 'githubRepository');
  const sshMatch = /^git@github\.com:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch?.groups?.repo) {
    return sshMatch.groups.repo;
  }

  const httpsMatch = /^https:\/\/github\.com\/(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch?.groups?.repo) {
    return httpsMatch.groups.repo;
  }

  const shorthandMatch = /^(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthandMatch?.groups?.repo) {
    return shorthandMatch.groups.repo;
  }

  throw new ServiceError('invalid_github_repository', 'GitHub repository must be owner/name, https URL, or git@ URL', {
    github_repository: value,
  });
}

function sanitizeProjectDirectory(projectSlug: string): string {
  return projectSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

function normalizeRequiredValue(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ServiceError('invalid_project_setup', `${field} is required`);
  }

  return normalized;
}

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAgentProvider(value: unknown): 'codex' | 'claude' | 'grok' | null {
  return value === 'codex' || value === 'claude' || value === 'grok' ? value : null;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }

  return fallback;
}

function hasOwnValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return true;
}

function coercePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function ensureObject(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObject(container[key]);
  container[key] = existing;
  return existing;
}

function setNestedString(root: Record<string, unknown>, pathSegments: string[], value: string): void {
  const target = ensureNestedObject(root, pathSegments.slice(0, -1));
  target[pathSegments[pathSegments.length - 1]] = value;
}

function setNestedNumber(root: Record<string, unknown>, pathSegments: string[], value: number): void {
  const target = ensureNestedObject(root, pathSegments.slice(0, -1));
  target[pathSegments[pathSegments.length - 1]] = value;
}

function setNestedValue(root: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  const target = ensureNestedObject(root, pathSegments.slice(0, -1));
  target[pathSegments[pathSegments.length - 1]] = value;
}

function deleteNestedValue(root: Record<string, unknown>, pathSegments: string[]): void {
  if (pathSegments.length === 0) {
    return;
  }

  const parent = ensureNestedObject(root, pathSegments.slice(0, -1));
  delete parent[pathSegments[pathSegments.length - 1]];
}

function ensureNestedObject(root: Record<string, unknown>, pathSegments: string[]): Record<string, unknown> {
  let current = root;
  for (const segment of pathSegments) {
    current = ensureObject(current, segment);
  }
  return current;
}
