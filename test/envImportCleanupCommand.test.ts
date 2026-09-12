import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import EnvImportCleanup from '../src/commands/env/import/cleanup.js';
import {createDotenvSourceBinding} from '../src/lib/dotenvImport.js';
import {enumerateSiblingArtifacts} from '../src/lib/envSourceCleanup.js';

const roots: string[] = [];

async function runCommand(argv: string[]): Promise<{stdout: string; error?: Error; exitCode: number; result?: unknown}> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = () => {};
  console.warn = () => {};
  let error: Error | undefined;
  let exitCode = 0;
  let result: unknown;
  try {
    const config = await Config.load({root: path.join(__dirname, '..')});
    result = await EnvImportCleanup.run(argv.slice(1), config);
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : Number(process.exitCode ?? 0);
  } catch (caught) {
    error = caught as Error;
    exitCode = (caught as {oclif?: {exit?: number}}).oclif?.exit ?? 1;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.exitCode = originalExitCode;
  }
  return {stdout: lines.join('\n'), error, exitCode, result};
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sift-import-cleanup-'));
  roots.push(root);
  return root;
}

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as Response;
}

const BANNED = ['securely deleted', 'wiped', 'erased', 'cannot be recalled', 'secure deletion'];

async function receiptFor(root: string, source: string, importId: string) {
  const raw = await readFile(source);
  const nonce = 'A'.repeat(43);
  const binding = createDotenvSourceBinding(raw, nonce);
  const receiptFile = path.join(root, 'import.receipt.json');
  await writeFile(receiptFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'sift.vault.import-receipt',
    dialect: 'sift-csv-v1',
    sourcePath: source,
    sourceNonce: binding.sourceNonce,
    sourceDigest: binding.sourceDigest,
    planId: '22222222-2222-4222-8222-222222222222',
    planDigest: 'c'.repeat(64),
    importId,
    ownerType: 'user',
    ownerId: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    counts: {created: 1, updated: 0, kept: 0, skipped: 0},
    completedAt: '2026-09-11T12:00:00.000Z',
  }));
  return receiptFile;
}

async function bindingFor(source: string, overrides: Record<string, unknown> = {}) {
  const binding = createDotenvSourceBinding(await readFile(source), 'A'.repeat(43));
  return {
    planId: '22222222-2222-4222-8222-222222222222',
    dialect: 'sift-csv-v1',
    sourceNonce: binding.sourceNonce,
    sourceDigest: binding.sourceDigest,
    planDigest: 'c'.repeat(64),
    status: 'applied',
    appliedAt: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

function stubImportStatus(importId: string, status: string, planBinding: Record<string, unknown> | null) {
  vi.stubGlobal('fetch', vi.fn(async () => response(200, {
    import: {id: importId, status, sourceFormat: 'csv', totalRows: 1, importedCount: 1, skippedCount: 0, planBinding},
  })));
}

describe('sift env import cleanup', () => {
  it('removes the reviewed source, warns on siblings, and stays honest', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    await writeFile(source, 'Key,Secret Value\nAPI_TOKEN,synthetic\n');
    await writeFile(`${source}~`, 'stale backup');
    await writeFile(path.join(root, '.legacy.csv.swp'), 'swap');
    const importId = '33333333-3333-4333-8333-333333333333';
    const receiptFile = await receiptFor(root, source, importId);
    stubImportStatus(importId, 'completed', await bindingFor(source));

    const result = await runCommand([
      'cleanup', '--source', source, '--receipt-file', receiptFile, '--yes',
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({removed: true, importId, plaintextRemnantsMayRemain: true});
    await expect(access(source)).rejects.toThrow();
    // Siblings are warned, never deleted.
    await expect(access(`${source}~`)).resolves.toBeUndefined();
    for (const phrase of BANNED) {
      expect(result.stdout.toLowerCase()).not.toContain(phrase);
    }
    expect(result.stdout).toContain('Plaintext may remain');
  });

  it('refuses when the import is not completed, the source drifted, or the receipt mismatches', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    await writeFile(source, 'Key,Secret Value\nAPI_TOKEN,synthetic\n');
    const importId = '33333333-3333-4333-8333-333333333333';
    const receiptFile = await receiptFor(root, source, importId);
    const base = ['--source', source, '--receipt-file', receiptFile, '--yes',
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token'];

    const binding = await bindingFor(source);
    stubImportStatus(importId, 'processing', binding);
    const pending = await runCommand(['cleanup', ...base]);
    expect(pending.exitCode).not.toBe(0);
    await expect(access(source)).resolves.toBeUndefined();

    // A completed import whose server-held plan binding names a different
    // plan or source digest (a forged or substituted receipt) refuses.
    for (const forged of [
      null,
      {...binding, planDigest: 'e'.repeat(64)},
      {...binding, planId: '99999999-9999-4999-8999-999999999999'},
      {...binding, sourceDigest: 'f'.repeat(64)},
      {...binding, status: 'active'},
    ]) {
      stubImportStatus(importId, 'completed', forged);
      const refused = await runCommand(['cleanup', ...base]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.error?.message).toContain('nothing was removed');
      await expect(access(source)).resolves.toBeUndefined();
    }

    await writeFile(source, 'Key,Secret Value\nAPI_TOKEN,changed-after-import\n');
    stubImportStatus(importId, 'completed', binding);
    const drifted = await runCommand(['cleanup', ...base]);
    expect(drifted.exitCode).not.toBe(0);
    await expect(access(source)).resolves.toBeUndefined();

    const other = path.join(root, 'other.csv');
    await writeFile(other, 'Key,Secret Value\nX,1\n');
    const mismatched = await runCommand(['cleanup', '--source', other, '--receipt-file', receiptFile, '--yes',
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token']);
    expect(mismatched.exitCode).not.toBe(0);
    await expect(access(other)).resolves.toBeUndefined();
  });

  it('enumerates sibling artifact kinds without deleting', async () => {
    const root = await checkout();
    const source = path.join(root, 'data.csv');
    await writeFile(source, 'a,b\n');
    await writeFile(path.join(root, 'data.csv.bak'), 'b');
    await writeFile(path.join(root, '#data.csv#'), 'e');
    await writeFile(path.join(root, 'data copy.csv'), 'c');
    await writeFile(path.join(root, 'unrelated.txt'), 'u');
    const warnings = await enumerateSiblingArtifacts(source);
    expect(warnings.map((warning) => warning.kind).sort()).toEqual(['backup', 'copy', 'editor']);
    expect(warnings.some((warning) => warning.path.endsWith('unrelated.txt'))).toBe(false);
  });
});
