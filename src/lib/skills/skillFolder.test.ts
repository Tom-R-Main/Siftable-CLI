import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readSkillFolder} from './skillFolder.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-skill-folder-')); });
afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}); });

describe('readSkillFolder', () => {
  it('reads every regular file by relative path, as base64, in a stable order', async () => {
    await fs.mkdir(path.join(dir, 'reference'));
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# Skill');
    await fs.writeFile(path.join(dir, 'reference', 'a.md'), 'a');
    expect(readSkillFolder(dir)).toEqual([
      {path: 'SKILL.md', content: Buffer.from('# Skill').toString('base64')},
      {path: 'reference/a.md', content: Buffer.from('a').toString('base64')},
    ]);
  });

  it('refuses a folder without SKILL.md, and a symlink rather than following it', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), 'x');
    expect(() => readSkillFolder(dir)).toThrow(/no SKILL.md/);
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
    await fs.symlink('/etc/hosts', path.join(dir, 'hosts'));
    expect(() => readSkillFolder(dir)).toThrow(/symlink/);
  });
});
