# Stori Product Vision

## Product Thesis

Stori should be the craft-first worldbuilding system for serious indie game developers and small game teams who need more than a notes app and less chaos than a custom wiki.

The wedge is not AI generation. The wedge is a polished product that helps creators start a world correctly, structure it with confidence, and trust the canon as it grows.

## Launch Customer

- Serious indie game developers building narrative-heavy or lore-heavy games.
- Small game teams with one primary canon owner.
- Creators who need reusable world rules, linked entities, and a source of truth they can trust over months or years of production.

## Core Problem

Current worldbuilding tools force creators to do too much manual organizational work. They usually fail in four ways:

- they make worldbuilding feel like admin work instead of creative work
- they provide weak structure, so users invent their own organization every time
- they make canon hard to link, retrieve, and maintain
- they erode trust once the world becomes large enough that memory is no longer enough

## Core Job To Be Done

Help a creator go from a blank page to a structured, cross-referenced world bible they can trust and expand over time.

That means Stori must do three things well:

1. Guide first-time setup from a blank slate.
2. Preserve consistency as the world grows.
3. Make canon fast to navigate and retrieve later.

## Product Principles

### Craft First

Stori should feel like a creative instrument, not an automation layer trying to replace the author.

### Opinionated Structure

The product should provide a real framework for worldbuilding, not an empty canvas with tags and loose notes.

### Trustworthy Canon

Users should feel confident that the current state of the world is accurate, linked, and recoverable.

### UX Is Strategic

Design quality is part of the moat. A rough workflow is a product failure, not a cosmetic defect.

### AI Must Respect Authorship

AI can later assist with linking, reconciliation, and guided exploration, but it should never take authorship away from the user without explicit intent.

## v1 Experience Shape

### Primary User Shape

v1 is optimized for a single primary creator. Future collaboration should remain architecturally possible, but multiplayer workflows, permissions, and team editing must not drive the first product decisions.

### Entry Point

The first run should start with a friendly, skippable guided setup that helps a creator define:

- the world's premise and tone
- the main organizing frame for the setting
- foundational rules or power logic
- a small starter set of core entities

### Core Entity Model

v1 should ship with a strongly opinionated set of entity types. The default launch set is:

- characters
- locations
- factions
- rules or power systems
- cultures
- items
- timeline events

The product should prefer predefined entity types and explicit relationships over open-ended schema design.

### Canon Management Promise

Stori must make it easy to:

- create structured entities quickly
- link entities together with explicit relationships
- browse the graph of related canon
- search and retrieve specific facts later
- understand what is current and trustworthy

### Surfaces

Ship one responsive web app.

- Desktop is the primary environment for deep creation work.
- Mobile web supports lookup, navigation, and light edits.
- Native apps are out of scope for v1.

## Explicit Non-Goals For v1

- AI-first positioning
- autonomous writing features
- collaboration as the primary wedge
- native desktop or mobile apps
- broad integrations or import tooling at launch
- a full writing suite or publishing workflow

## Quality Bar

The first release should be uncompromising on:

- visual design
- reliability and data integrity
- ease of use

Fewer features with stronger product quality is the correct tradeoff.

## Monetization Hypothesis

Start with a free-plus-paid-upgrade model.

- Free should be strong enough for a creator to meaningfully start a world.
- Paid should become attractive once the user has real investment in their canon and needs more scale, depth, or control.

## Success Signals

### 12-Month Aspiration

- at least $20,000 in monthly profit
- category leadership for structured worldbuilding in games

### Early Positive Signals

- users complete onboarding and create a real world foundation
- users return repeatedly after first setup
- users keep expanding canon instead of reverting to general-purpose tools
- some committed users convert after becoming invested in their world

### Negative Signal

If users trial Stori, then move back to competitors and stay there, the direction should be reconsidered quickly.

## Execution Slices

### Slice 1: Guided Foundation

- onboarding wizard
- initial world setup
- opinionated entity model
- polished first-use UX

### Slice 2: Linked Canon

- entity linking
- relationship navigation
- strong retrieval and search
- canonical trust and integrity

### Slice 3: Monetization And Expansion Hooks

- free versus paid boundaries
- responsive mobile hardening
- technical preparation for later AI and collaboration layers

## Decision Heuristics For Agents

When a ticket does not fully specify a product choice, prefer:

- structured entities over free-form notes
- explicit relationships over loose tagging
- canon trust and retrieval over novelty features
- desktop depth plus mobile lookup over mobile-first authoring
- a narrower but more polished v1 over broader flexibility
- single-creator ergonomics over team abstractions
