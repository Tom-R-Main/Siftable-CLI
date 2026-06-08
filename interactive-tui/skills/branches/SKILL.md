---
name: branches
version: 1.0.0
description: Fan work out across parallel child branches and land the good ones, with you as the merge authority. Use when the user asks to "split this into parallel agents", "fan out", "work on these in parallel", "spawn a child / branch", "do these independently", "review and merge the branches", "land the ready ones", or "what's ready to merge". Drives the mergeMaster lifecycle (spawn worktree → ready-to-merge gate → squash-merge) through safe tools — never raw git. Landing is always human-approved.
triggers:
  - split this into parallel agents
  - fan out the work
  - work on these in parallel
  - spawn a child branch
  - what's ready to merge
  - land the ready branches
  - review and merge the branches
allowed-tools:
  - list_branches
  - spawn_branch
  - ready_branch
  - merge_branch
metadata:
  author: siftable
---

# Branches — parallel child branches, you are the merge authority

Treat this file as executable instructions. "Branches" are child sessions: each
is **a git branch with a conversation attached** — an isolated worktree on its
own `sift/*` branch, forked from the parent's base. You are the **parent: the
merge authority.** Children do work in isolation; you decide what lands. You
drive the lifecycle with four tools, and the human approves every land.

## The four tools (use these — never raw git)

- **`list_branches`** — read-only dashboard. Each child's branch, status, gate
  verdict (`ready_to_merge` / `merge_blocked`), changed files, ±lines, how far
  the base advanced, and blockers. Start here.
- **`spawn_branch`** — create a child. **Prefer a scoped writer:** pass `scope`
  with the file globs it will touch, so concurrent writers serialize (Gate-A).
  Use `readonly` for an investigator that only reads; `unscoped` is the escape
  hatch for a writer with no declared scope (not serialized — avoid unless you
  must).
- **`ready_branch`** — run the ready-to-merge gate (lane D) against the *current*
  base; sets the child `ready_to_merge` or `merge_blocked`. Read-only unless you
  pass `autoCommit`. Returns the verdict + blockers; lands nothing.
- **`merge_branch`** — land a ready child via squash-merge (lane E).
  **Approval-gated: the human approves every land.** Refuses as a perfect no-op
  if the child isn't `ready_to_merge` or a conflict surfaces.

## When to spawn vs. work inline

**Spawn a child** when the work is disjoint and parallelizable, risky/experimental
and worth isolating, or you want several independent attempts. **Work inline**
when it's small, sequential, single-file, or needs the parent's live context.
Don't spawn for a trivial edit — the worktree overhead isn't worth it.

## Scope discipline (Gate-A)

A `read_write` child declares the globs it will write. Two writers with
*overlapping* scope are serialized — only one holds a given scope at a time — so
they can't clobber each other. Declare the **tightest** scope that covers the
work. Out-of-scope writes block the merge, by design.

## The status machine (don't fight it)

```
running        → needs_input | ready_to_merge | merge_blocked | abandoned
needs_input    → running | abandoned
ready_to_merge → merged | rejected | merge_blocked | running | abandoned
merge_blocked  → running | ready_to_merge | rejected | abandoned
merged / rejected / abandoned → terminal
```

You **cannot** go `running → merged` directly — landing passes through
`ready_to_merge` (the gate). A child parked in `needs_input` can't be merged
until it's `running` again.

## Safety invariants (hold no matter what you do)

- `ready_branch` and `merge_branch` re-evaluate against the **current** base — a
  stale gate result is always re-checked at land time.
- A squash-merge that hits a conflict, an empty diff, or a rejected commit
  **rolls the base back to its exact prior tip** — a refused land is a perfect
  no-op. You never half-land.
- A successful land **force-deletes** the merged branch (squash doesn't mark it
  merged); the work is preserved in the base squash commit.

## The loop

1. `list_branches` — read the field.
2. For each independent piece of work, `spawn_branch` with a **tight scope**.
3. Do the work in the child (edit/commit normally — the worktree is the child's).
4. `ready_branch` — gate it. If `merge_blocked`, read the blockers.
5. Decide:
   - `ready_to_merge` → `merge_branch` (the human approves the land).
   - `merge_blocked` by **conflict** → the base moved or the child overlaps;
     rebase/resolve the child against the base, then `ready_branch` again.
   - `merge_blocked` by **out-of-scope** writes → tighten or re-scope the work.
   - not worth saving → leave it (it stays inspectable) or abandon it.
6. Repeat until the ready set is empty.

## Decision guidance

- **Base moved under a ready child** → just `ready_branch` again; the gate
  re-checks against the new base. Don't panic-merge.
- **Two children both ready, related concerns** → land the smaller/safer one
  first, then `ready_branch` the other (the base just moved, so re-gate it).
- **A child stuck `merge_blocked` twice** → stop fanning out. Resolve it inline
  or abandon it. Don't loop forever spawning around a hard conflict.

## Boundaries

- **Never** bypass the tools with raw `git merge` / `git branch -D` /
  `git worktree` in `run_terminal_command` — that skips the gate, the scope
  contract, and the rollback safety. Always go through spawn → ready → merge.
- You **never** land without approval — `merge_branch` always prompts the human,
  who is the ultimate merge authority.
