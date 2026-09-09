import { statSync } from 'node:fs';

/** Observation guard, not a filesystem compare-and-swap. The write engine must
 * still enforce containment; a concurrent writer after this check remains a
 * filesystem-level race until the native commit path supports conditional writes. */
export function fileVersion(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function assertFileVersion(path: string, expected: string | null): void {
  if (fileVersion(path) !== expected) throw new Error('File changed since observation; read it again before editing');
}
