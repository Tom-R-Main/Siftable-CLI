#!/usr/bin/env bash
#
# Release build for the native Zig modules. Produces the prebuilt dynamic
# libraries that ship in the npm tarball so that `npm i -g @siftable/cli` is
# Zig-by-default — not falling back to the slower TypeScript path.
#
#   - Host platform (darwin-arm64 today): built + tested + cell-render vendored
#     by the existing build-native.sh. This MUST succeed; we never publish
#     without working host natives.
#   - Cross targets (linux-x64): built best-effort. Zig cross-compiles these
#     from any host. If a cross build fails, we warn and continue — every native
#     module has a lockstep TypeScript fallback (see threadEngine.ts et al.), so
#     a missing/broken lib degrades gracefully instead of crashing.
#
# Adding a platform: append a target triple below. NOTE: the runtime loader
# (e.g. native/thread_engine.ts) keys on process.platform only, NOT arch — so
# you can ship at most one arch per OS (.dylib / .so / .dll never collide, but
# linux-x64 and linux-arm64 would). Multi-arch-per-OS needs arch-aware
# filenames in the loaders first.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Host build (required): tests, host natives, cell-render vendoring.
echo ">> Building host natives (required)..."
./scripts/build-native.sh

# 2. Cross targets (best-effort). suffix is implied by the target triple.
CROSS_TARGETS=(
  "x86_64-linux"
)

for triple in "${CROSS_TARGETS[@]}"; do
  echo ">> Cross-building native libs for ${triple}..."
  if zig build native -Doptimize=ReleaseSafe -Dtarget="${triple}" -p .; then
    echo ">> ok: ${triple}"
  else
    echo "warning: cross build for ${triple} failed; that platform will use the TypeScript fallback" >&2
  fi
done

echo ">> Release native build complete. Shipping:"
ls -1 native/lib*.dylib native/lib*.so native/lib*.dll 2>/dev/null || true
