#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

suffix="$(bun -e 'import { suffix } from "bun:ffi"; console.log(suffix)')"

zig test native/composer_policy.zig
zig test native/fs_engine.zig
zig test native/image_engine.zig

zig build-lib native/composer_policy.zig -dynamic -OReleaseFast -femit-bin="native/libcomposer_policy.${suffix}"
zig build-lib native/fs_engine.zig -dynamic -OReleaseFast -femit-bin="native/libfs_engine.${suffix}"
zig build-lib native/image_engine.zig -dynamic -OReleaseFast -femit-bin="native/libimage_engine.${suffix}"

echo "built native/libcomposer_policy.${suffix}"
echo "built native/libfs_engine.${suffix}"
echo "built native/libimage_engine.${suffix}"
