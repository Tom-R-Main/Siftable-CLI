// The real `sift review` model session against a stand-in codex binary: native
// provider mode, with a login file this process cannot open (mode 000), so a
// passing run proves no CLI or Taster code path opened it.

import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {classifyModelFailure, codexAuthPath, codexSessionFactory} from './codexSession.js';
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

const METADATA_NOTICE = {type: 'item.completed', item: {id: 'w', type: 'error', message: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'}};

/** Runs one finder call `calls` times against a codex whose turn fails with `message`; returns problems(). */
async function failedTurnProblems(message: string, calls: number): Promise<string[]> {
  return failingCodexProblems([
    {type: 'thread.started', thread_id: 't'},
    {type: 'turn.started'},
    {type: 'turn.failed', error: {message}},
  ], 0, 'turn_failed', calls);
}

/** Runs one finder call `calls` times against a codex that prints `events` and exits `exitCode`; returns problems(). */
async function failingCodexProblems(events: object[], exitCode: number, code: string, calls: number): Promise<string[]> {
  const bin = join(dir, 'codex-failing');
  const out = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(out)}, () => process.exit(${exitCode}));\n`);
  chmodSync(bin, 0o755);
  const session = await codexSessionFactory({
    runtime,
    codexBin: bin,
    model: 'gpt-6.1-sol',
    path: `/usr/bin:/bin`,
    concurrency: 1,
    callTimeoutMs: 20_000,
    authFile: join(dir, 'auth.json'),
  })({checkoutRoot: mkdtempSync(join(dir, 'checkout-')), workDir: mkdtempSync(join(dir, 'work-'))});
  for (let i = 0; i < calls; i++) {
    await expect(session.models.run({
      role: 'finder',
      callId: `c${i}`,
      instructions: 'Find defects.',
      data: [],
      outputSchema: '{}',
      toolHost: {tools: ['read_file'], call: async () => ({ok: false, error: 'unused'})},
      signal: AbortSignal.timeout(20_000),
    })).rejects.toMatchObject({code});
  }
  await session.close();
  return session.problems();
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

  it('reports a failed turn by class and never echoes codex\'s message', async () => {
    const marker = `acct-${Math.random().toString(36).slice(2)}`;
    const problems = await failedTurnProblems(`You've hit your usage limit for ${marker}. Try again later.`, 2);
    expect(problems).toEqual(['model call failed (finder turn_failed:usage_limit) x2']);
    expect(JSON.stringify(problems)).not.toContain(marker);
  });

  it('suggests signing in only when codex reported an authentication failure', async () => {
    const problems = await failedTurnProblems('unexpected status 401 Unauthorized: Your session has expired', 1);
    expect(problems).toEqual([
      'model call failed (finder turn_failed:auth) x1',
      'codex reported an authentication failure: run `codex login` (file-based credential storage) and retry',
    ]);
    expect(JSON.stringify(problems)).not.toContain('session has expired');
  });

  it('reports an unrecognised failure as other, with no part of its text', async () => {
    // Fixed text: a random marker could happen to contain a pattern such as "dns".
    const message = 'frobnicator zqvellum declined politely';
    const problems = await failedTurnProblems(message, 1);
    expect(problems).toEqual(['model call failed (finder turn_failed:other) x1']);
    const reported = JSON.stringify(problems);
    for (const word of message.split(' ')) expect(reported).not.toContain(word);
  });

  it('gives no class to a completed turn whose output is invalid, despite an informational warning', async () => {
    const problems = await failingCodexProblems([
      {type: 'thread.started', thread_id: 't'},
      {type: 'turn.started'},
      METADATA_NOTICE,
      {type: 'item.completed', item: {id: 'm', type: 'agent_message', text: 'not json'}},
      {type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0}},
    ], 0, 'invalid_output', 1);
    expect(problems).toEqual(['model call failed (finder invalid_output) x1']);
  });

  it('classifies a process that ended without a terminal event by its last stream error', async () => {
    const problems = await failingCodexProblems([
      {type: 'thread.started', thread_id: 't'},
      {type: 'turn.started'},
      METADATA_NOTICE,
      {type: 'error', message: 'stream disconnected before completion'},
    ], 1, 'process_failed', 1);
    expect(problems).toEqual(['model call failed (finder process_failed:network) x1']);
  });

  it('classifies codex failure messages into a fixed set', () => {
    expect(classifyModelFailure(undefined)).toBeUndefined();
    expect(classifyModelFailure('  ')).toBeUndefined();
    expect(classifyModelFailure("You've hit your usage limit. Upgrade to Pro")).toBe('usage_limit');
    expect(classifyModelFailure('exceeded retry limit, last status: 429 Too Many Requests')).toBe('rate_limit');
    expect(classifyModelFailure('unexpected status 401 Unauthorized: token expired')).toBe('auth');
    expect(classifyModelFailure('Not logged in')).toBe('auth');
    expect(classifyModelFailure('Input exceeds the context window of this model')).toBe('context_length');
    expect(classifyModelFailure('The model `gpt-x` does not exist or you do not have access to it')).toBe('model_unavailable');
    expect(classifyModelFailure("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.")).toBe('model_unavailable');
    expect(classifyModelFailure('The model `gpt-6.1-sol` does not exist or you do not have access to it.')).toBe('model_unavailable');
    expect(classifyModelFailure('Model loaded. Request not found.')).toBe('other');
    expect(classifyModelFailure(METADATA_NOTICE.item.message)).toBe('other');
    expect(classifyModelFailure('unexpected status 503 Service Unavailable')).toBe('server_error');
    expect(classifyModelFailure('stream disconnected before completion')).toBe('network');
    expect(classifyModelFailure('turn failed')).toBe('other');
  });

  it('locates the login under CODEX_HOME or ~/.codex without touching it', () => {
    expect(codexAuthPath({CODEX_HOME: '/opt/codex-home'})).toBe('/opt/codex-home/auth.json');
    expect(codexAuthPath({CODEX_HOME: 'relative'})).toMatch(/\/\.codex\/auth\.json$/u);
    expect(codexAuthPath({})).toMatch(/\/\.codex\/auth\.json$/u);
  });
});
