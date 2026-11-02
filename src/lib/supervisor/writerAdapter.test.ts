import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {PLACEHOLDER_KEY, runWriter, writerInvocation} from './writerAdapter.js';

const ANTHROPIC = 'http://sift-a-r1-relay:8787/sift/v1/model/anthropic';
const OPENAI = 'http://sift-a-r1-relay:8787/sift/v1/model/openai/v1';
/** Shell metacharacters, quotes, a newline and a leading dash: all must arrive as one argument, unexpanded. */
const PROMPT = '-x Fix $(rm -rf /) `id` "quoted" \'single\'\nsecond line; echo pwned';

let dir: string;
let bin: string;
let record: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-writer-test-'));
  bin = path.join(dir, 'bin');
  record = path.join(dir, 'record.json');
  await fs.mkdir(bin);
  // Each fake CLI records its argv, environment and home, then exits 7.
  const fake = `#!${process.execPath}\nconst fs = require('node:fs');\nconst home = process.env.HOME;\n`
    + `const list = (d) => { try { return fs.readdirSync(d, {recursive: true}).map(String).sort(); } catch { return null; } };\n`
    + `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, home: list(home),\n`
    + `  settings: (() => { try { return JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8')); } catch { return null; } })(),\n`
    + `  config: (() => { try { return fs.readFileSync(require('node:path').join(process.env.CODEX_HOME || '/none', 'config.toml'), 'utf8'); } catch { return null; } })()}));\n`
    + 'process.exit(7);\n';
  for (const name of ['claude', 'codex']) await fs.writeFile(path.join(bin, name), fake, {mode: 0o755});
});
afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}); });

async function run(writer: unknown, env: NodeJS.ProcessEnv = {}) {
  const input = path.join(dir, 'input.json');
  await fs.writeFile(input, JSON.stringify({version: 1, task: {title: 'Fix', prompt: PROMPT}, plan: {writer}}));
  const lines: string[] = [];
  const code = await runWriter({PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_BASE_URL: ANTHROPIC, OPENAI_BASE_URL: OPENAI,
    ANTHROPIC_API_KEY: 'sk-ant-leak', OPENAI_API_KEY: 'sk-leak', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-leak', ...env}, input, dir, (line) => lines.push(line));
  const seen = await fs.readFile(record, 'utf8').then((text) => JSON.parse(text) as {argv: string[]; env: Record<string, string>;
    home: string[] | null; settings: {apiKeyHelper?: string} | null; config: string | null}, () => null);
  return {code, seen, lines};
}

describe('writer adapter (U6 R4)', () => {
  it('starts Claude Code non-interactively against the relay, in a fresh home, with the prompt as one argument', async () => {
    const {code, seen} = await run({protocol: 'anthropic', model: 'claude-opus-5-5'});
    expect(code).toBe(7);
    expect(seen?.argv).toEqual(['-p', '--model', 'claude-opus-5-5', '--max-turns', '40', '--dangerously-skip-permissions',
      '--settings', expect.stringMatching(/sift-settings\.json$/), '--', PROMPT]);
    expect(seen?.env.ANTHROPIC_BASE_URL).toBe(ANTHROPIC);
    expect(seen?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(seen?.settings).toEqual({apiKeyHelper: `printf %s ${PLACEHOLDER_KEY}`});
    // A fresh home holding only the settings it wrote: no login, credentials or auth file.
    expect(seen?.env.HOME.startsWith(path.join(dir, 'sift-writer-home-'))).toBe(true);
    expect(seen?.home).toEqual(['sift-settings.json']);
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(seen?.env[key]).toBeUndefined();
  });

  it('starts codex exec with one provider at the relay and no auth file', async () => {
    const {code, seen} = await run({protocol: 'openai', model: 'gpt-6.1-sol'});
    expect(code).toBe(7);
    expect(seen?.argv).toEqual(['exec', '-m', 'gpt-6.1-sol', '--skip-git-repo-check', '--', PROMPT]);
    expect(seen?.env.SIFT_RELAY_KEY).toBe(PLACEHOLDER_KEY);
    expect(seen?.env.CODEX_HOME).toBe(path.join(seen!.env.HOME, '.codex'));
    expect(seen?.home).toEqual(['.codex', path.join('.codex', 'config.toml')]);
    expect(seen?.config).toContain(`base_url = "${OPENAI}"`);
    expect(seen?.config).toContain('wire_api = "responses"');
    expect(seen?.config).toContain('approval_policy = "never"');
    expect(seen?.config).toContain('sandbox_mode = "danger-full-access"');
    expect(seen?.config).toContain('env_key = "SIFT_RELAY_KEY"');
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) expect(seen?.env[key]).toBeUndefined();
  });

  it('gives every run its own home', async () => {
    const first = await run({protocol: 'anthropic', model: 'm'});
    const second = await run({protocol: 'anthropic', model: 'm'});
    expect(first.seen?.env.HOME).not.toBe(second.seen?.env.HOME);
  });

  it.each([
    ['no writer', undefined],
    ['an unsupported protocol', {protocol: 'gemini', model: 'm'}],
    ['a model with a space', {protocol: 'openai', model: 'a b'}],
    ['a model with a quote', {protocol: 'openai', model: 'a"b'}],
  ])('starts nothing for %s', async (_label, writer) => {
    const {code, seen, lines} = await run(writer);
    expect(code).toBe(78);
    expect(seen).toBeNull();
    expect(lines.join('')).toMatch(/^sift writer: /);
  });

  it('starts nothing without a relay base URL, or one a config file could misread', async () => {
    expect((await run({protocol: 'openai', model: 'm'}, {OPENAI_BASE_URL: ''})).code).toBe(78);
    expect((await run({protocol: 'openai', model: 'm'}, {OPENAI_BASE_URL: 'http://relay/v1"\nmodel = "x'})).code).toBe(78);
    expect((await run({protocol: 'anthropic', model: 'm'}, {ANTHROPIC_BASE_URL: 'http://user:pw@relay'})).code).toBe(78);
  });

  it('reports a CLI missing from the image', async () => {
    await fs.rm(path.join(bin, 'claude'));
    const input = path.join(dir, 'input.json');
    await fs.writeFile(input, JSON.stringify({task: {prompt: 'p'}, plan: {writer: {protocol: 'anthropic', model: 'm'}}}));
    const lines: string[] = [];
    expect(await runWriter({PATH: bin, ANTHROPIC_BASE_URL: ANTHROPIC}, input, dir, (line) => lines.push(line))).toBe(127);
    expect(lines.join('')).toMatch(/claude is not installed/);
  });

  it('links the pinned skills read-only into each CLI\'s home, and nothing when none are mounted', async () => {
    const skills = path.join(dir, 'mounted-skills');
    await fs.mkdir(path.join(skills, 'date-parsing'), {recursive: true});
    const input = {plan: {writer: {protocol: 'anthropic', model: 'claude-opus-5-5'}}, task: {prompt: 'Fix'}};
    const claude = writerInvocation(input, {ANTHROPIC_BASE_URL: ANTHROPIC}, dir, skills);
    const codex = writerInvocation({...input, plan: {writer: {protocol: 'openai', model: 'gpt-6.1-sol'}}}, {OPENAI_BASE_URL: OPENAI}, dir, skills);
    const none = writerInvocation(input, {ANTHROPIC_BASE_URL: ANTHROPIC}, dir, path.join(dir, 'absent'));
    if (typeof claude === 'string' || typeof codex === 'string' || typeof none === 'string') throw new Error('no invocation');
    expect(await fs.readlink(path.join(claude.env.HOME as string, '.claude', 'skills'))).toBe(skills);
    expect(await fs.readlink(path.join(codex.env.CODEX_HOME as string, 'skills'))).toBe(skills);
    await expect(fs.lstat(path.join(none.env.HOME as string, '.claude', 'skills'))).rejects.toThrow();
  });
});
