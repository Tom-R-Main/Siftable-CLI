---
name: work
version: 1.0.0
description: Operate the agent work queue — read the board, decide what to hand off vs. do inline, plan the queue's order, and prove a claim with code/test evidence before shipping. Use when the user asks to "show the queue / work board", "what should I work on", "hand this off to an agent", "plan the work", "what's blocked", "prove this works", or "is this ready to ship". The human drives the /work hub (board · plan · focus · proof · handoff); your job is the judgment around it.
triggers:
  - show the work queue
  - what should I work on
  - hand this off to an agent
  - plan the agent work
  - what is blocked
  - prove this claim
  - is this ready to ship
allowed-tools:
  - code_search
metadata:
  author: siftable
---

# Work — operating the agent work queue

Treat this file as executable judgment. The **work queue** (`agent_work_items`)
is the durable backlog of claimable, verifiable units of agent work — each with a
prompt, an assigned agent, an optional file scope, acceptance criteria, and
verification commands. The human drives it through the **`/work` hub** (an
arrow-navigable overlay: a board of items, plus the verbs below). Your job is the
judgment *around* the queue: what belongs in it, in what order, and what evidence
backs a claim before it ships.

This is the queue of *durable work items*. It is **not** the same as `/branches`
(parallel child git branches you review and merge) — a work item describes work;
a branch *is* an in-flight attempt. See `[[branches]]` when the task is "fan this
out across parallel agents and land the good ones."

## The hub's verbs (what the human can do from `/work`)

- **board** — work items grouped by status (running / claimed / queued / blocked /
  needs_review), agents folded into the header. `↵` expands an item's detail
  (prompt, scope, acceptance, verification, blockers).
- **`p` plan** — the deterministic queue DAG (`/plan work`): precedence order +
  critical path, rendered as a diagram. Use to answer "what's the right order".
- **`f` focus** — the 3–5 highest-leverage next actions across queue + tasks +
  calendar + dirty git.
- **`v` proof** — code/test evidence for the *selected* work item (query built
  from its title + acceptance + prompt), so "done" is backed by something real.
- **`h` handoff** — create a new work item from the live context (title / agent /
  files / acceptance).
- **`r` recap / `s` ship** — recent-work themes; diff summary + suggested tests.

## When to hand off vs. do it inline

**Hand off** (create a work item) when the work is *durable and dispatchable*: it
has a crisp title, can be verified by a command, and could be done by another
agent or later by you without the current conversation in your head. **Do it
inline** when it's small, needs this conversation's live context, or is faster to
just do than to describe. Don't hand off a one-line edit — the work item costs
more than the fix.

A good work item is **self-contained**: a clear title, the file scope it should
touch, acceptance criteria phrased as checks, and a verification command
(`npm test …`). A vague "improve the dashboard" item is noise; "Fix composer
paste dropping the first line — acceptance: pasted multi-line text preserved;
verify: `npm test -- composer`" is dispatchable.

## Ordering the queue (plan)

When several items relate, order matters. `/plan work` derives precedence from
file-scope overlap and sibling rank and shows the critical path. Trust it for the
default order; teach it an edge it can't infer with `/plan --after SRC:DST`, and
persist a derived order with `/plan --apply` (writes
`.siftable/plans/overlay.json` — durable + inspectable). Don't hand-serialize
work the planner already orders.

## Proof before shipping

Before you claim a work item is done — or before `/ship` — back it with evidence.
Use `code_search` (the `v` proof view does this for the selected item) to find the
code and the test that exercise the change. "It should work" is not proof; a test
file path that covers the acceptance criterion is. If there's no test evidence,
say so plainly rather than implying coverage that isn't there.

## Boundaries

- Creating/persisting a work item is a **write**. Surface a clear handoff proposal
  (title, agent, scope, acceptance) and let the human confirm it through the hub —
  don't fabricate items silently.
- Reading the board, planning, focus, and proof are read-only — do them freely.
- Don't conflate work items with `[[branches]]`: plan and hand off here; spawn and
  merge there.

Related: [[branches]] [[plan]]
