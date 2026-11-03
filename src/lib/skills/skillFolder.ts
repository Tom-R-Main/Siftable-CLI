/**
 * Reads a local skill folder for `sift skills publish` (skill-pin-v1.md): every regular file under it, by relative
 * path, as base64. A symlink, a socket or anything else is refused rather than followed, so what is published is
 * exactly what is in the folder. The server checks the file set again.
 */
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const MAX_FILES = 64;
const MAX_BYTES = 256 * 1024;

export function readSkillFolder(root: string): Array<{path: string; content: string}> {
  const files: Array<{path: string; content: string}> = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`${relative} is a symlink; a published skill holds only regular files`);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile()) throw new Error(`${relative} is not a regular file`);
      total += stat.size;
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error(`a skill has at most ${MAX_FILES} files and ${MAX_BYTES} bytes`);
      files.push({path: relative, content: readFileSync(full).toString('base64')});
    }
  };
  walk(root);
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error(`${root} has no SKILL.md at its root`);
  return files;
}
