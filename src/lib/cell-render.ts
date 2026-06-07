import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const BIN_NAME = 'cell-render';

export const CELL_RENDER_MISSING_MESSAGE =
  'cell-render binary not found.\n' +
  'Build it (cd ~/projects/image-to-ascii && zig build) or set SIFT_CELL_RENDER_BIN to its path.';

/**
 * Locate the `cell-render` binary (the image-to-ascii / "Cell Render" project).
 *
 * Order: SIFT_CELL_RENDER_BIN → vendored `interactive-tui/native/cell-render`
 * (populated by interactive-tui/scripts/build-native.sh) → the sibling
 * image-to-ascii repo build output → PATH.
 */
export function resolveCellRenderBin(startDir: string = __dirname): string | null {
  const fromEnv = process.env.SIFT_CELL_RENDER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Walk up from the compiled command to the package root, where the TUI vendors
  // the binary alongside its native dylibs.
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const vendored = join(dir, 'interactive-tui', 'native', BIN_NAME);
    if (existsSync(vendored)) return vendored;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  const sibling = join(homedir(), 'projects', 'image-to-ascii', 'zig-out', 'bin', BIN_NAME);
  if (existsSync(sibling)) return sibling;

  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [BIN_NAME], {
    encoding: 'utf8',
  });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split('\n').map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  }
  return null;
}
