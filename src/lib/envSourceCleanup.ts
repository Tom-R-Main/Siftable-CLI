import {constants} from 'node:fs';
import {lstat, open, readdir, unlink} from 'node:fs/promises';
import path from 'node:path';

export type SiblingArtifactKind = 'backup' | 'swap' | 'editor' | 'copy';

export interface SiblingArtifactWarning {
  path: string;
  kind: SiblingArtifactKind;
}

export interface ImportSourceSnapshot {
  path: string;
  device: number;
  inode: number;
}

/**
 * Enumerate likely sibling artifacts of an imported source file. These are
 * warnings only: the caller must never delete them automatically. Plaintext
 * may survive in any of them, which is exactly why removal language stays
 * honest (see the cleanup command output contract).
 */
export async function enumerateSiblingArtifacts(sourcePath: string): Promise<SiblingArtifactWarning[]> {
  const directory = path.dirname(sourcePath);
  const base = path.basename(sourcePath);
  const parsed = path.parse(base);
  const warnings: SiblingArtifactWarning[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return warnings;
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stem = parsed.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ext = parsed.ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: Array<{kind: SiblingArtifactKind; test: RegExp}> = [
    {kind: 'backup', test: new RegExp(`^(${escaped}~|${escaped}\\.(bak|orig|old))$`)},
    {kind: 'swap', test: new RegExp(`^\\.${escaped}\\.(swp|swo|swn)$`)},
    {kind: 'editor', test: new RegExp(`^(#${escaped}#|\\.#${escaped})$`)},
    {
      kind: 'copy',
      test: new RegExp(`^(${stem} copy( \\(\\d+\\))?${ext}|${stem} \\(\\d+\\)${ext}|${escaped}\\.tmp)$`),
    },
  ];
  for (const name of names) {
    if (name === base) continue;
    for (const pattern of patterns) {
      if (pattern.test.test(name)) {
        warnings.push({path: path.join(directory, name), kind: pattern.kind});
        break;
      }
    }
  }
  warnings.sort((left, right) => left.path.localeCompare(right.path));
  return warnings;
}

/**
 * Remove exactly the identity-verified imported source file. Refuses
 * symlinks, identity drift, and directories. Deletes one path only.
 *
 * Node has no unlinkat-by-handle, so the directory entry is unlinked by
 * path. The verified file is held open across the unlink and its link
 * count is checked afterwards: if the entry was swapped in the window
 * between the final path check and the unlink, the held file still has a
 * link, and the caller is told that a different file at that path was
 * removed instead of a silent success.
 */
export async function removeImportedSource(snapshot: ImportSourceSnapshot): Promise<void> {
  const handle = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== snapshot.device || opened.ino !== snapshot.inode || opened.nlink !== 1) {
      throw new Error('Import source changed or is no longer a stable single-link regular file; nothing was removed.');
    }
    const current = await lstat(snapshot.path);
    if (current.isSymbolicLink() || !current.isFile()
      || current.dev !== snapshot.device || current.ino !== snapshot.inode) {
      throw new Error('Import source changed or is no longer a stable regular file; nothing was removed.');
    }
    await unlink(snapshot.path);
    const after = await handle.stat();
    if (after.nlink !== 0) {
      throw new Error(
        `The directory entry at ${snapshot.path} was replaced during removal and the replacement was unlinked; `
        + 'the reviewed import source still exists under another entry.',
      );
    }
  } finally {
    await handle.close();
  }
}
