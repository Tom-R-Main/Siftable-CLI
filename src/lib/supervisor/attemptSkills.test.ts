import {createHash} from 'node:crypto';
import {promises as fs, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {checkServedSkills, planSkillsProblem, prepareSkills, skillDigest, type SkillPin, SKILLS_DIR, writeSkills} from './attemptSkills.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const file = (name: string, text: string) => {
  const bytes = Buffer.from(text);
  return {path: name, content: bytes.toString('base64'), bytes: bytes.length, sha256: sha(bytes)};
};
/** A skill as the server serves it, with the pin the plan would carry. */
function served(key: string, files = [file('SKILL.md', `# ${key}`), file('reference/notes.md', 'notes')], version = 1) {
  const digest = skillDigest(files);
  return {skill: {key, version, sha256: digest, files}, pin: {key, version, sha256: digest} as SkillPin};
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-skills-')); });
afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}); });

describe('skill digest (golden vectors)', () => {
  it('reproduces every skill vector the shared reference wrote', () => {
    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../docs/architecture/signing-golden-vectors.json'), 'utf8')) as
      {skills: Array<{name: string; files: Array<{path: string; sha256: string; bytes: number}>; sha256: string}>};
    expect(fixture.skills.length).toBeGreaterThan(0);
    for (const vector of fixture.skills) expect(skillDigest(vector.files), vector.name).toBe(vector.sha256);
  });
});

describe('served skills against the plan\'s pins (skill-pin-v1.md)', () => {
  it('takes exactly the pinned skills, decoded', () => {
    const a = served('date-parsing');
    const b = served('style', [file('SKILL.md', 'style')]);
    const checked = checkServedSkills([a.pin, b.pin], [b.skill, a.skill]);
    if (typeof checked === 'string') throw new Error(checked);
    expect(checked.map((skill) => skill.key)).toEqual(['date-parsing', 'style']);
    expect(checked[0].files.find((f) => f.path === 'reference/notes.md')?.bytes.toString()).toBe('notes');
  });

  it('refuses a skill changed after approval, a missing or extra one, and another version', () => {
    const a = served('date-parsing');
    const changed = {...a.skill, files: [file('SKILL.md', '# changed'), a.skill.files[1]]};
    expect(checkServedSkills([a.pin], [changed])).toMatch(/does not match|changed after/);
    // A changed file served with its own honest sha256 still changes the skill's digest.
    expect(checkServedSkills([a.pin], [{...changed, files: changed.files}])).toBeTypeOf('string');
    expect(checkServedSkills([a.pin], [])).toMatch(/exactly the pinned/);
    expect(checkServedSkills([a.pin], [a.skill, served('extra').skill])).toMatch(/exactly the pinned/);
    expect(checkServedSkills([a.pin], [{...a.skill, version: 2}])).toMatch(/not the pinned version/);
    expect(checkServedSkills([a.pin], [{...a.skill, sha256: 'f'.repeat(64)}])).toMatch(/not the pinned version/);
  });

  it('refuses unsafe paths, overlaps, a missing SKILL.md, a size lie and the byte cap before writing anything', () => {
    const cases: Array<[string, ReturnType<typeof file>[], RegExp]> = [
      ['traversal', [file('SKILL.md', 'x'), file('../escape', 'x')], /segment/],
      ['absolute', [file('SKILL.md', 'x'), file('/etc/x', 'x')], /plain relative/],
      ['overlap', [file('SKILL.md', 'x'), file('docs', 'x'), file('docs/a', 'x')], /directory is also a file/],
      ['duplicate', [file('SKILL.md', 'x'), file('SKILL.md', 'x')], /twice/],
      ['no entry', [file('README.md', 'x')], /no SKILL.md/],
      ['cap', [file('SKILL.md', 'x'.repeat(256 * 1024 + 1))], /over/],
    ];
    for (const [name, files, problem] of cases) {
      const {skill, pin} = served('s', files);
      expect(checkServedSkills([pin], [skill]), name).toMatch(problem);
    }
    const {skill, pin} = served('s');
    expect(checkServedSkills([pin], [{...skill, files: [{...skill.files[0], bytes: 999}, skill.files[1]]}])).toMatch(/size and sha256/);
    expect(checkServedSkills([pin], [{...skill, files: [{...skill.files[0], content: 'not base64!'}, skill.files[1]]}])).toMatch(/base64/);
  });

  it('checks the plan\'s pins themselves', () => {
    expect(planSkillsProblem(undefined)).toBeUndefined();
    expect(planSkillsProblem([served('a').pin])).toBeUndefined();
    expect(planSkillsProblem([served('a').pin, served('a').pin])).toMatch(/twice/);
    expect(planSkillsProblem([{key: 'A', version: 1, sha256: 'f'.repeat(64)}])).toMatch(/malformed/);
    expect(planSkillsProblem(Array.from({length: 9}, (_, i) => served(`s${i}`).pin))).toMatch(/at most 8/);
  });
});

describe('fetching and writing', () => {
  it('fetches with the claim, writes read-only files under skills/<key>, and fails the start on any mismatch', async () => {
    const a = served('date-parsing');
    const calls: Array<{route: string; body: unknown}> = [];
    const session = (skills: unknown, status = 200) => ({call: async (_m: string, route: string, body?: unknown) => {
      calls.push({route, body});
      return {status, body: {skills}};
    }});
    const attempt = {workItemId: 'w1', attemptId: 'a1', claimToken: 'claim', timeoutMs: 1000};
    expect(await prepareSkills(session([a.skill]) as never, attempt, [a.pin], dir)).toBeUndefined();
    expect(calls[0]).toEqual({route: '/api/v1/work-items/w1/execution-attempts/a1/skills', body: {claimToken: 'claim'}});
    const written = path.join(dir, SKILLS_DIR, 'date-parsing', 'reference/notes.md');
    expect(await fs.readFile(written, 'utf8')).toBe('notes');
    expect((await fs.stat(written)).mode & 0o777).toBe(0o444);

    expect(await prepareSkills(session([], 200) as never, attempt, [a.pin], path.join(dir, 'other'))).toMatch(/exactly the pinned/);
    expect(await prepareSkills(session(null, 409) as never, attempt, [a.pin], path.join(dir, 'other'))).toMatch(/HTTP 409/);
    await expect(fs.stat(path.join(dir, 'other'))).rejects.toThrow();
    calls.length = 0;
    expect(await prepareSkills(session([]) as never, attempt, undefined, dir)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('never overwrites a file already written', async () => {
    const a = served('s');
    const checked = checkServedSkills([a.pin], [a.skill]);
    if (typeof checked === 'string') throw new Error(checked);
    await writeSkills(dir, checked);
    await expect(writeSkills(dir, checked)).rejects.toThrow();
  });
});
