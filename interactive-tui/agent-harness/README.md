# Siftable Agent Harness

This directory is the source-owned runtime for `sift interactive`. It is an
intentional product fork, not a vendored dependency or a mirror that should be
periodically overwritten.

## Ownership

`@siftable/cli` owns this code and evolves it for the terminal product. Changes
to this tree do not need to be copied back to OpenFunction, and OpenFunction
changes do not flow here automatically. Any future code transfer must be an
explicit, reviewed port based on behavior the TUI actually needs.

The supported import boundary is [`index.ts`](./index.ts). It intentionally
exports only:

- `createChatAgent`
- `JsonlSessionEventStore`
- `defineTool`
- `ok`
- `err`

Everything below `framework/` and `providers/` is internal implementation.

## Provenance

This tree was separated on 2026-08-25 from
[`Tom-R-Main/openFunctions`](https://github.com/Tom-R-Main/openFunctions). The
last committed source revision at separation was
`819012c88129db5b49c7fdcb5254c72213e5ae3d`. The initial fork also includes
session-journal and runtime hardening developed in both working trees before
the split, so that commit identifies ancestry rather than a byte-for-byte
snapshot.

## Scope

Keep this harness focused on behavior used by the Siftable terminal: chat-agent
execution, provider adapters, durable session state, tool execution, prompt
assembly, and Siftable context tools. Do not copy features from OpenFunction
solely to preserve parity.

Generic MCP server, RAG, workflow, crew/agent, structured-output, OpenClaw,
PostgreSQL-store, and framework test-runner surfaces were intentionally not
retained because the terminal does not execute them.

## Work-item tools

The Siftable provider exposes the authoritative queue contract. Create and
dependency-replacement tools accept `dependsOn` entries containing a work-item
UUID and optional `requiredGate` (`done` or `commands_passed`). List/get
responses return server-derived `dependencies` and `claimability`; repo-local
planning overlays never change claimability.

Claim returns an opaque `claimToken`. Lease-owned lifecycle actions must pass
that token and the same `claimOwner`; human review-resolution and cancellation
remain subject to the backend lifecycle matrix.
