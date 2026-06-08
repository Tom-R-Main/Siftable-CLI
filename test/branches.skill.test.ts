/**
 * Lane E A3 — the `branches` builtin skill. It is the agent-facing decision
 * layer for the mergeMaster lifecycle: discovered like the other builtin skills
 * (plan, mermaid), loadable by the `skill` tool, and documenting the four branch
 * tools + the safety invariants the agent must respect. This guards that the
 * skill ships, parses, and carries the load-bearing guidance.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discoverSkills, loadSkill} from '../interactive-tui/skillsEngine';

const BUILTIN_DIR = join(__dirname, '..', 'interactive-tui', 'skills');

let emptyHome: string;

beforeEach(async () => {
  // Isolate from the host's real ~/.claude etc. so discovery only sees builtins.
  emptyHome = await realpath(await mkdtemp(join(tmpdir(), 'sift-skills-home-')));
});
afterEach(async () => {
  await rm(emptyHome, {recursive: true, force: true});
});

describe('lane E A3 — branches builtin skill', () => {
  it('is discovered alongside the other builtin skills', () => {
    const skills = discoverSkills({builtinDir: BUILTIN_DIR, home: emptyHome, projectRoot: emptyHome, cwd: emptyHome});
    const names = skills.map((s) => s.name);
    expect(names).toContain('branches');
    expect(names).toEqual(expect.arrayContaining(['plan', 'mermaid'])); // sanity: builtin scan worked
  });

  it('loads with a non-empty body and a clear description', () => {
    const skills = discoverSkills({builtinDir: BUILTIN_DIR, home: emptyHome, projectRoot: emptyHome, cwd: emptyHome});
    const info = skills.find((s) => s.name === 'branches');
    expect(info).toBeTruthy();
    expect(info!.description.toLowerCase()).toMatch(/parallel|merge|branch/);

    const loaded = loadSkill('branches', skills);
    expect(loaded).toBeTruthy();
    expect(loaded!.body.length).toBeGreaterThan(500);
  });

  it('documents all four branch tools and the load-bearing invariants', () => {
    const skills = discoverSkills({builtinDir: BUILTIN_DIR, home: emptyHome, projectRoot: emptyHome, cwd: emptyHome});
    const body = loadSkill('branches', skills)!.body;

    for (const tool of ['list_branches', 'spawn_branch', 'ready_branch', 'merge_branch']) {
      expect(body).toContain(tool);
    }
    // The non-negotiable guidance: human authority over landing + no-op rollback.
    expect(body).toMatch(/merge authority/i);
    expect(body).toMatch(/approval-gated|human approves|never.*land.*without approval/i);
    expect(body).toMatch(/rolls the base back|perfect no-op/i);
    // Scope discipline and the gate-before-merge rule.
    expect(body).toMatch(/scope/i);
    expect(body).toMatch(/ready_to_merge/);
  });
});

/**
 * The TS `parseFrontmatter` fallback (exercised here under node, where the Bun
 * FFI dylib is absent) must agree with native/skill_meta.zig. These cases mirror
 * the Zig inline tests one-for-one, so a drift in either parser shows up as a
 * failing test on one side. (Discovery is the only public seam onto the fallback.)
 */
describe('skill frontmatter — TS fallback parity with skill_meta.zig', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sift-skill-parity-')));
  });
  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  async function writeSkill(dir: string, content: string): Promise<void> {
    const d = join(root, '.agents', 'skills', dir);
    await mkdir(d, {recursive: true});
    await writeFile(join(d, 'SKILL.md'), content, 'utf8');
  }

  function discover() {
    return discoverSkills({projectRoot: root, cwd: root, home: root, builtinDir: join(root, '__no_builtins__')});
  }

  it('parses quotes, BOM, CRLF, nested-keys, comments; skips no-name', async () => {
    await writeSkill('a-quotes', `---\nname: "quoted name"\ndescription: 'single quoted'\n---\nbody\n`);
    await writeSkill('b-bom', `﻿---\nname: bom-skill\ndescription: d\n---\n`);
    await writeSkill('c-crlf', `---\r\nname: crlf-skill\r\ndescription: windows\r\n---\r\n`);
    await writeSkill('d-nested', `---\nname: nested-skill\ndescription: keep this\ntriggers:\n  - x\nmetadata:\n  author: y\n---\nname: not-this\n`);
    await writeSkill('e-comment', `---\n# a comment\n\nname: comment-skill\n\ndescription: d\n---\n`);
    await writeSkill('f-noname', `---\ndescription: only a description\n---\n`);
    await writeSkill('g-empty-name', `---\nname: ""\ndescription: d\n---\n`);

    const byName = new Map(discover().map((s) => [s.name, s]));

    expect(byName.get('quoted name')?.description).toBe('single quoted');
    expect(byName.get('bom-skill')?.description).toBe('d');
    expect(byName.get('crlf-skill')?.description).toBe('windows');
    expect(byName.get('nested-skill')?.description).toBe('keep this'); // nested/list keys ignored
    expect(byName.get('comment-skill')?.description).toBe('d');
    expect(byName.has('not-this')).toBe(false); // a name: in the BODY is not frontmatter
    // No-name and empty-name files yield no skill at all.
    const names = [...byName.keys()];
    expect(names).not.toContain('');
    expect(names.filter((n) => n.includes('only a description'))).toEqual([]);
  });

  it('skips a file with no closing fence', async () => {
    await writeSkill('h-unclosed', `---\nname: unclosed\nstill going\n`);
    expect(discover().some((s) => s.name === 'unclosed')).toBe(false);
  });
});
