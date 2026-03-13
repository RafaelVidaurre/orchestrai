# Stori Harness Engineering Strategy

This project should follow the operating direction from OpenAI's harness engineering guidance: keep the repository as the system of record, replay real tasks instead of relying on abstract benchmarks, and convert every repeated confusion into a durable harness artifact.

## Why Harness Engineering Matters For Stori

Stori aims to win on product judgment, UX quality, and canon trust. Those are exactly the kinds of qualities that drift when agents work without a strong harness.

Without a harness, unattended work will tend to:

- overfit to isolated tickets instead of the product thesis
- add flexible but low-trust features that dilute the wedge
- regress onboarding, canon integrity, or mobile readability without noticing
- repeat the same confusion across runs because the learning never becomes an artifact

The harness should reduce that entropy.

## System Of Record

Within this workflow folder, the long-lived source of truth is:

- `docs/product-vision.md` for product intent and decision heuristics
- `docs/open-questions.md` for unresolved choices plus safe defaults
- `docs/harness-engineering.md` for the operating model
- `harness/scenarios/*.md` for the starter golden task corpus
- `WORKFLOW.md` for compact execution instructions and issue-handling policy

Linear comments and workpads are execution logs, not the permanent product brief.

## Core Harness Principles

### 1. Replay Real Product Tasks

Evaluate changes with representative user tasks, not vague notions of correctness. For Stori, the most important tasks are:

- starting a world from nothing
- creating structured canon entities
- linking related canon
- retrieving facts later with confidence
- navigating on mobile for lookup and short edits

### 2. Prefer Product Artifacts Over Memory

If an agent needed extra explanation to make a good decision, that explanation should usually become one of:

- a workflow rule
- a product doc update
- a new scenario spec
- a deterministic fixture or validation script in the product repo later

### 3. Keep The Harness Close To The Work

The harness should live next to the Stori workflow so every unattended run can read it before planning. The goal is not a giant knowledge dump. The goal is a small set of reusable artifacts that sharpen product judgment.

### 4. Turn Ambiguity Into Defaults

Unresolved product questions should not stall execution. Capture them in `docs/open-questions.md`, define a default, and continue until a ticket explicitly requires a different answer.

### 5. Make Quality Observable

For Stori, correctness is not only data validity. It also includes:

- whether onboarding creates a useful world foundation
- whether entities remain understandable as they grow
- whether relationships stay navigable
- whether source-of-truth trust increases rather than decays
- whether mobile remains viable for lookup and small edits

The harness should always ask for evidence on those points.

## Execution Loop For Agents

For any Stori ticket:

1. Read `docs/product-vision.md` and any relevant scenario files.
2. Reproduce the issue or identify the affected golden task.
3. Implement the smallest change that improves the target task.
4. Validate using the closest matching scenario, plus any direct tests or runtime checks needed for the scope.
5. If the work exposed a missing expectation, update the docs or scenario corpus before handoff.

## Golden Task Coverage To Grow Over Time

The starter scenario set should grow in this order:

1. Guided foundation setup
2. Structured entity authoring
3. Linked canon navigation
4. Search and retrieval
5. Mobile lookup and light edits
6. Integrity warnings and conflict detection
7. Monetization boundaries
8. Later AI-assist flows

When a ticket changes one of these flows, either validate the existing scenario or update it so the next run inherits the learning.

## Harness Assets The Stori Product Repo Should Eventually Add

These do not all need to exist yet, but the workflow should push toward them:

- seeded sample worlds with dense cross-links
- deterministic onboarding fixtures
- scenario-specific viewport presets for desktop and mobile
- scripts that launch the app into known states quickly
- integrity checks for broken references and required-field gaps
- search relevance fixtures that verify important facts remain retrievable
- golden screenshots or scripted walkthrough captures for high-sensitivity flows

## Required Evidence By Change Type

### Product-Surface Change

- scenario mapping in the workpad
- direct validation of the affected user flow
- updated scenario doc if the expected behavior changed

### Data-Model Or Canon-Integrity Change

- evidence that structured entities and links still round-trip correctly
- explicit note on backward compatibility or migration handling
- validation of retrieval paths back to the changed entity

### Mobile-Oriented Change

- narrow viewport evidence
- proof that navigation and small edits still work without desktop-only affordances

## Failure Handling

When an unattended run struggles, do not only fix the immediate code. Decide which missing harness artifact would have prevented the struggle:

- missing product rule
- missing default assumption
- missing scenario spec
- missing fixture
- missing validation script

Then add that artifact if it is in scope.

## What Good Looks Like

The harness is doing its job when a new agent can enter the Stori workflow, read the local docs, and make decisions that are:

- aligned with the craft-first product thesis
- consistent across tickets
- biased toward canon trust and strong UX
- less likely to regress mobile lookup, onboarding, or relationship clarity

That is the standard to maintain.
