import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ToolExecutionContext} from '../agent-harness/framework/execution-context';
import {verifyCandidate, verifyReceiptCurrent} from '../candidateVerification';

let root: string;
let context: ToolExecutionContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-candidate-verification-'));
  await writeFile(join(root, 'candidate.txt'), 'original');
  context = {sessionId: 'session', turnId: 'turn', callId: 'check', workspaceRoot: root, sessionCwd: root, approval: {policy: 'allow', scopeId: 'test-workspace'}};
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
function check(code: string, options: Partial<Parameters<typeof verifyCandidate>[0]> = {}) {
  return verifyCandidate({argv: [process.execPath, '-e', code], files: ['candidate.txt'], context, ...options});
}

describe('candidate-bound verification', () => {
  test('binds a passing explicit check to file hashes and current observations', async () => {
    const receipt = await check('console.log("passed fixture")');
    expect(receipt.status).toBe('passed');
    expect(receipt.dispatched).toBe(true);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout).toContain('passed fixture');
    expect(receipt.before?.files[0]).toMatchObject({path: 'candidate.txt', bytes: 8});
    expect(receipt.before?.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.before?.sha256).toBe(receipt.after?.sha256);
    expect(receipt.completedAt >= receipt.startedAt).toBe(true);
    expect(verifyReceiptCurrent(receipt)).toEqual({current: true});
  });

  test('persists a frozen prepared snapshot before dispatch', async () => {
    let prepared: Parameters<NonNullable<Parameters<typeof verifyCandidate>[0]['onPrepared']>>[0] | undefined;
    const receipt = await check('require("fs").writeFileSync("dispatched", "yes")', {onPrepared: candidate => {
      prepared = candidate;
      expect(existsSync(join(root, 'dispatched'))).toBe(false);
      expect(candidate.status).toBe('unknown');
      expect(candidate.reason).toBe('check_in_progress');
      expect(candidate.completedAt).toBe('');
      expect(candidate.before).not.toBeNull();
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.before?.files)).toBe(true);
    }});
    expect(receipt.status).toBe('passed');
    expect(receipt.reason).toBeUndefined();
    expect(prepared?.status).toBe('unknown');
    expect(prepared?.completedAt).toBe('');
  });

  test('a failed prepared-receipt write prevents all command effects', async () => {
    await expect(check('require("fs").writeFileSync("dispatched", "bad")', {onPrepared: () => {throw new Error('journal unavailable');}})).rejects.toThrow('journal unavailable');
    expect(existsSync(join(root, 'dispatched'))).toBe(false);
  });

  test('a check that edits a candidate produces a stale receipt', async () => {
    const receipt = await check('require("fs").writeFileSync("candidate.txt", "changed")');
    expect(receipt.exitCode).toBe(0);
    expect(receipt.status).toBe('stale');
    expect(receipt.reason).toBe('candidate_changed_during_check');
    expect(verifyReceiptCurrent(receipt).current).toBe(false);
  });

  test('a check that changes then restores candidate bytes still cannot certify it', async () => {
    const receipt = await check('const fs=require("fs"); fs.writeFileSync("candidate.txt", "changed"); fs.writeFileSync("candidate.txt", "original")');
    expect(receipt.before?.files[0]?.sha256).toBe(receipt.after?.files[0]?.sha256);
    expect(receipt.status).toBe('stale');
  });

  test('a later candidate edit invalidates an earlier passing receipt', async () => {
    const receipt = await check('process.exit(0)');
    await writeFile(join(root, 'candidate.txt'), 'edited later');
    expect(verifyReceiptCurrent(receipt)).toEqual({current: false, reason: 'candidate_changed_since_check'});
  });

  test('a nonzero check remains failed with captured diagnostics', async () => {
    const receipt = await check('console.error("assertion failed"); process.exit(7)');
    expect(receipt.status).toBe('failed');
    expect(receipt.exitCode).toBe(7);
    expect(receipt.stderr).toContain('assertion failed');
    expect(verifyReceiptCurrent(receipt).current).toBe(false);
  });

  test.each(['deny', 'ask'] as const)('%s authority never dispatches', async policy => {
    const receipt = await check('require("fs").writeFileSync("dispatched", "bad")', {context: {...context, approval: {policy, scopeId: 'fixture'}}});
    expect(receipt.dispatched).toBe(false);
    expect(receipt.reason).toBe('approval_required');
    expect(existsSync(join(root, 'dispatched'))).toBe(false);
  });

  test('pre-cancellation never dispatches', async () => {
    const controller = new AbortController(); controller.abort();
    const receipt = await check('require("fs").writeFileSync("dispatched", "bad")', {context: {...context, signal: controller.signal}});
    expect(receipt.status).toBe('interrupted');
    expect(receipt.dispatched).toBe(false);
    expect(existsSync(join(root, 'dispatched'))).toBe(false);
  });

  test('cancellation waits for the running check to settle', async () => {
    const controller = new AbortController();
    const pending = check('require("fs").writeFileSync("ready", "1"); setInterval(()=>{},100)', {context: {...context, signal: controller.signal}, timeoutMs: 2000});
    try {
      const deadline = Date.now() + 1000;
      while (!existsSync(join(root, 'ready')) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(root, 'ready'))).toBe(true);
      controller.abort();
      const receipt = await pending;
      expect(receipt.status).toBe('interrupted');
      expect(receipt.dispatched).toBe(true);
      expect(receipt.terminationConfirmed).toBe(true);
    } finally { controller.abort(); await pending; }
  });

  test('deadline cancellation cannot produce a passing receipt', async () => {
    const receipt = await check('setInterval(()=>{},100)', {timeoutMs: 60});
    expect(receipt.status).toBe('interrupted');
    expect(receipt.reason).toBe('check_timed_out');
  });

  test('requires an explicit allowlist and confines it to regular workspace files', async () => {
    await expect(check('process.exit(0)', {files: []})).rejects.toThrow('allowlist');
    await expect(check('process.exit(0)', {files: ['../outside']})).rejects.toThrow('escapes');
    const directory = await check('process.exit(0)', {files: ['.']});
    expect(directory.dispatched).toBe(false);
    expect(directory.status).toBe('unknown');
  });

  test('does not follow a symlink to a file outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sift-candidate-outside-'));
    try {
      await writeFile(join(outside, 'outside.txt'), 'outside canary');
      await symlink(outside, join(root, 'linked'));
      const receipt = await check('require("fs").writeFileSync("dispatched", "bad")', {files: ['linked/outside.txt']});
      expect(receipt.dispatched).toBe(false);
      expect(receipt.status).toBe('unknown');
      expect(JSON.stringify(receipt)).not.toContain('outside canary');
      expect(existsSync(join(root, 'dispatched'))).toBe(false);
    } finally { await rm(outside, {recursive: true, force: true}); }
  });

  test('quotes each argv element without interpreting its metacharacters', async () => {
    const argument = `literal ' $(touch injected) ;`;
    const receipt = await verifyCandidate({argv: ['/usr/bin/printf', '%s', argument], files: ['candidate.txt'], context});
    expect(receipt.status).toBe('passed');
    expect(receipt.stdout).toBe(argument);
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  test('bounds output and sanitizes known credentials before returning a receipt', async () => {
    const old = process.env.SIFT_TEST_SECRET;
    process.env.SIFT_TEST_SECRET = 'opaque-known-fixture-credential';
    try {
      const receipt = await check('console.log("opaque-known-fixture-credential"); console.log("x".repeat(10000))', {maxOutputBytes: 256});
      expect(receipt.status).toBe('passed');
      expect(receipt.outputTruncated).toBe(true);
      expect(receipt.stdout.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(receipt)).not.toContain('opaque-known-fixture-credential');
      expect(receipt.argv.join(' ')).toContain('[REDACTED]');
      expect(receipt.stdout).toContain('[REDACTED]');
    } finally {
      if (old === undefined) delete process.env.SIFT_TEST_SECRET;
      else process.env.SIFT_TEST_SECRET = old;
    }
  });

  test('does not stream unsanitized check output to an inherited observer', async () => {
    const chunks: string[] = [];
    const receipt = await check('console.log("token=fixture-secret")', {context: {...context, onOutput: output => {chunks.push(output.text);}}});
    expect(chunks).toEqual([]);
    expect(receipt.stdout).toContain('[REDACTED]');
    expect(receipt.stdout).not.toContain('fixture-secret');
  });
});
