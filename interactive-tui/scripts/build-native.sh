#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

suffix="$(bun -e 'import { suffix } from "bun:ffi"; console.log(suffix)')"

zig build test
zig build native -Doptimize=ReleaseSafe -p .

echo "built native/libcomposer_policy.${suffix}"
echo "built native/libfs_engine.${suffix}"
echo "built native/libimage_engine.${suffix}"
echo "built native/libcollab_engine.${suffix}"
echo "built native/libthread_engine.${suffix}"
echo "built native/libmerge_master.${suffix}"
echo "built native/libskill_meta.${suffix}"

# Vendor the cell-render binary (the sibling image-to-ascii / "Cell Render" repo)
# so `sift mermaid`, `sift image`, and the TUI /mermaid + /image commands work
# from a packaged install. Best-effort: on failure the runtime locator falls back
# to the sibling repo's zig-out or PATH, so a missing repo is a warning, not a
# build break.
cell_render_src="${SIFT_IMAGE_TO_ASCII_DIR:-$HOME/projects/image-to-ascii}"
if [ -d "$cell_render_src" ]; then
  if (cd "$cell_render_src" && zig build -Doptimize=ReleaseSafe); then
    cp "$cell_render_src/zig-out/bin/cell-render" native/cell-render
    chmod +x native/cell-render
    echo "vendored native/cell-render from $cell_render_src"
  else
    echo "warning: cell-render build failed; mermaid/image render will fall back to $cell_render_src/zig-out/bin or PATH" >&2
  fi
else
  echo "warning: image-to-ascii repo not found at $cell_render_src; skipping cell-render vendoring (set SIFT_IMAGE_TO_ASCII_DIR to override)" >&2
fi
