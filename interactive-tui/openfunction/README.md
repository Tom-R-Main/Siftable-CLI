Embedded OpenFunction Runtime
=============================

This directory contains the Siftable CLI's trimmed OpenFunction runtime slice.
It was copied from Tom-R-Main/openFunctions so `sift interactive` is
self-contained when installed from npm.

Keep this copy focused on the runtime path used by the terminal assistant:

- chat-agent runtime
- provider adapters
- tool registry and prompt helpers
- Siftable context provider

Do not add OpenFunction examples, workshop CLI code, MCP server mode, RAG,
Postgres storage, or plugin demos here unless `sift interactive` starts using
them directly.

Work-item tools
---------------

The embedded Siftable provider exposes the authoritative queue contract. Create
and dependency-replacement tools accept `dependsOn` entries containing a
work-item UUID and optional `requiredGate` (`done`, `commands_passed`, or
`verified`). List/get responses return server-derived `dependencies` and
`claimability`; repo-local planning overlays never change claimability.

Claim returns an opaque `claimToken`. Lease-owned lifecycle actions must pass
that token and the same `claimOwner`; human review-resolution and cancellation
remain subject to the backend lifecycle matrix.
