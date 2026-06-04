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
