# Stori Open Questions And Default Assumptions

This file captures unresolved product decisions that should not block unattended execution. Until a ticket or a human decision overrides them, agents should follow the proposed default and record any material assumption in the workpad.

## Launch Entity Model

### Question

What is the exact minimum launch set of entity types and fields?

### Proposed Default

Launch with seven entity types:

- character
- location
- faction
- rule or power system
- culture
- item
- timeline event

Each type should have a compact structured schema with a small set of required identity fields, a summary field, relationship slots, and type-specific detail sections. Avoid custom user-defined types in v1.

### Why It Matters

This decision defines the product's core structure and directly affects onboarding, navigation, and search.

## Relationship Vocabulary

### Question

How strict should the initial relationship model be?

### Proposed Default

Use typed relationships for common canon links instead of an open relationship builder. Prefer a modest curated set such as:

- character to faction
- character to location
- faction to location
- item to character
- item to faction
- event to involved entities
- rule or power system to affected entities

Allow an internal fallback relation only if needed for storage continuity, but do not expose a generic relationship editor as a primary v1 affordance.

### Why It Matters

Relationship design determines whether Stori feels clear and trustworthy or turns into another flexible but messy wiki.

## Onboarding Wizard Depth

### Question

How much should the first-run setup ask before the user reaches the workspace?

### Proposed Default

Keep the wizard to five skippable stages:

1. world premise
2. tone or genre
3. foundational rules or power logic
4. starting conflicts or tensions
5. starter entities to seed the workspace

The wizard should create useful first content, not just collect preferences.

### Why It Matters

Too little structure weakens the wedge. Too much upfront friction hurts activation.

## Mobile Editing Depth

### Question

What should mobile web support beyond viewing and lookup?

### Proposed Default

Support browsing, search, relationship navigation, and light edits such as:

- updating short fields
- adding or correcting summaries
- attaching or removing links
- creating quick stub entities

Do not optimize v1 mobile for long-form authoring or complex schema editing.

### Why It Matters

Mobile scope can easily bloat the product unless it is intentionally constrained.

## Free Tier Limits

### Question

What free limit is generous enough to create habit but still encourages upgrade?

### Proposed Default

Use one world with a moderate entity cap as the initial fence. A good first working assumption is:

- 1 active world
- up to 75 structured entities
- core search, linking, and browsing included
- premium gates reserved for higher scale, exports, or deeper history features

Treat these numbers as provisional product defaults, not implementation commitments.

### Why It Matters

The monetization boundary affects onboarding, retention, and perceived fairness.

## Integrity Features

### Question

Which non-AI trust mechanisms must exist in v1?

### Proposed Default

Ship clear manual trust features before any AI layer:

- backlinks and relationship browsing
- visible last-updated metadata
- deterministic structured fields
- warnings for empty required fields or broken references
- stable search and browse paths back to the source entity

### Why It Matters

Stori's wedge depends on trust in canon, not just content capture.

## Media And Visual Assets

### Question

How much image or map support belongs in v1?

### Proposed Default

Treat images and maps as supportive metadata, not core authoring primitives. Support simple cover images or references only if they do not slow the structured canon workflow. Full map tooling is out of scope for v1.

### Why It Matters

Visual features are attractive but can derail focus from the core structured-canon wedge.

## Collaboration Readiness

### Question

What architecture choices should stay future-safe for collaboration without shaping the v1 UX?

### Proposed Default

Keep the data model collaboration-ready by preserving:

- stable entity identifiers
- created-at and updated-at metadata
- explicit ownership-friendly audit fields
- conflict-safe relationship storage

Do not add team permissions, presence, or multiplayer editing UX in v1.

### Why It Matters

This preserves future expansion without contaminating the first product with premature complexity.

## Imports And Migration

### Question

When should competitor import tooling become part of the product?

### Proposed Default

Do not build imports for the first release. Revisit once there is evidence that users are blocked from adoption after understanding the product.

### Why It Matters

Import tooling can consume significant effort before the core workflow is proven.

## AI Introduction Path

### Question

What is the first acceptable AI role once the core product is trusted?

### Proposed Default

Introduce AI only after Stori is already valuable without it, and start with:

- link suggestions
- inconsistency flags
- guided prompts for missing canon decisions
- optional edit suggestions on explicit request

Do not introduce autonomous writing or AI-led authorship as the primary v1 or early-v2 value proposition.

### Why It Matters

This preserves Stori's authorship stance and keeps the launch narrative clear.
