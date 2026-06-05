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
