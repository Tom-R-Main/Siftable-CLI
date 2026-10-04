// The real `sift review` model session against a stand-in codex binary: native
// provider mode, with a login file this process cannot open (mode 000), so a
// passing run proves no CLI or Taster code path opened it.

import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {codexAuthPath, codexSessionFactory} from './codexSession.js';
import {loadTasterRuntime} from './runtime.js';

const runtime = loadTasterRuntime();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sift-review-session-'));
});

afterEach(() => {
  try {
    chmodSync(join(dir, 'auth.json'), 0o600);
  } catch {
    // Not created.
  }
  rmSync(dir, {recursive: true, force: true});
});

function fakeCodex(): string {
  const bin = join(dir, 'codex');
  const report = join(dir, 'report.json');
  const events = [
    {type: 'thread.started', thread_id: 't'},
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'm', type: 'agent_message', text: '{"ok":true}'}},
    {type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0}},
  ].map(event => JSON.stringify(event)).join('\n');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const home = process.env.CODEX_HOME;
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  entries: fs.readdirSync(home).sort(),
  link: fs.lstatSync(home + '/auth.json').isSymbolicLink() ? fs.readlinkSync(home + '/auth.json') : null,
  config: fs.readFileSync(home + '/config.toml', 'utf8'),
  env: Object.keys(process.env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort(),
}));
process.stdout.write(${JSON.stringify(`${events}\n`)});
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('sift review codex session', () => {
  it('runs codex in native mode with only a link to the login, which nothing here opens', async () => {
    const authFile = join(dir, 'auth.json');
    const secret = `login-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    writeFileSync(authFile, JSON.stringify({OPENAI_API_KEY: secret}));
    chmodSync(authFile, 0o000);
    const before = statSync(authFile);
    const checkout = mkdtempSync(join(dir, 'checkout-'));
    const workDir = mkdtempSync(join(dir, 'work-'));

    const session = await codexSessionFactory({
      runtime,
      codexBin: fakeCodex(),
      model: 'gpt-6.1-sol',
      path: `/usr/bin:/bin`,
      concurrency: 1,
      callTimeoutMs: 20_000,
      authFile,
    })({checkoutRoot: checkout, workDir});
    const response = await session.models.run({
      role: 'finder',
      callId: 'c1',
      instructions: 'Find defects.',
      data: [],
      outputSchema: '{}',
      toolHost: {tools: ['read_file'], call: async () => ({ok: false, error: 'unused'})},
      signal: AbortSignal.timeout(20_000),
    });
    await session.close();
    expect(response.output).toEqual({ok: true});

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as {entries: string[]; link: string | null; config: string; env: string[]};
    expect(report.entries).toEqual(['auth.json', 'config.toml']);
    expect(report.link).toBe(authFile);
    expect(report.config).toContain('model_provider = "openai"');
    expect(report.config).not.toContain('[model_providers');
    expect(report.config).not.toContain(secret);
    expect(report.env).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
    // The user's file is untouched and still unreadable; the per-call home is gone.
    const after = statSync(authFile);
    expect([after.mode & 0o777, after.size, after.mtimeMs]).toEqual([0, before.size, before.mtimeMs]);
  });

  it('locates the login under CODEX_HOME or ~/.codex without touching it', () => {
    expect(codexAuthPath({CODEX_HOME: '/opt/codex-home'})).toBe('/opt/codex-home/auth.json');
    expect(codexAuthPath({CODEX_HOME: 'relative'})).toMatch(/\/\.codex\/auth\.json$/u);
    expect(codexAuthPath({})).toMatch(/\/\.codex\/auth\.json$/u);
  });
});
