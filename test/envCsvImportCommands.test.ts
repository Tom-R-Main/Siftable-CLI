import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import EnvImportApply from '../src/commands/env/import/apply.js';
import EnvImportPlan from '../src/commands/env/import/plan.js';

/** Mimic jsonb object key ordering: shorter keys first, then bytewise. */
function jsonbKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbKeyOrder);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((key) => [key, jsonbKeyOrder(record[key])]));
  }
  return value;
}

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
    const CommandClass = argv[2] === 'apply' ? EnvImportApply : EnvImportPlan;
    result = await CommandClass.run(argv.slice(3), config);
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
  const root = await mkdtemp(path.join(tmpdir(), 'sift-csv-import-'));
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

const SECRET = 'synthetic-sentinel-csv-7d2a';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';

function planArgs(root: string, source: string, planFile: string, extra: string[] = []): string[] {
  return [
    'env', 'import', 'plan', '--format', 'csv', '--source', source, '--plan-file', planFile,
    '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    '--header-row', '1', '--map', 'name=Key', '--map', 'value=Secret Value', ...extra,
  ];
}

describe('sift env import plan/apply --format csv', () => {
  it('keeps values local during planning and writes a value-free artifact', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    const planFile = path.join(root, 'review.plan.json');
    await writeFile(source, `Key,Secret Value\nAPI_TOKEN,${SECRET}\n`);
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const entries = requestBody.entries as Array<Record<string, unknown>>;
      return response(201, {plan: {
        id: PLAN_ID,
        dialect: requestBody.dialect,
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        sourceNonce: requestBody.sourceNonce,
        sourceDigest: requestBody.sourceDigest,
        // PostgreSQL jsonb does not preserve key order; the CLI must compare
        // the returned profile canonically, not by JSON.stringify.
        sourceProfile: jsonbKeyOrder(requestBody.sourceProfile),
        planDigest: 'c'.repeat(64),
        items: entries.map((entry) => ({
          ...entry,
          conflictClass: 'none',
          proposedAction: 'create',
          targetName: entry.key,
          targetSlug: 'api_token',
          existingEntryId: null,
          existingEntryType: null,
          existingValueRevision: null,
        })),
        status: 'active',
        expiresAt: '2026-09-11T12:00:00.000Z',
      }});
    }));

    const result = await runCommand(planArgs(root, source, planFile));
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({kind: 'sift.vault.csv-import-plan'});
    expect(JSON.stringify(requestBody)).not.toContain(SECRET);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).toContain('API_TOKEN');
    expect(result.stdout).toContain('--format csv');
    expect(await readFile(planFile, 'utf8')).not.toContain(SECRET);
  });

  it('requires --header-row up front for CSV sources', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    const planFile = path.join(root, 'review.plan.json');
    await writeFile(source, 'Key,Secret Value\nA,1\n');
    const fetch = vi.fn(async () => response(500, {}));
    vi.stubGlobal('fetch', fetch);
    const result = await runCommand([
      'env', 'import', 'plan', '--format', 'csv', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
      '--map', 'name=Key', '--map', 'value=Secret Value',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain('--header-row is required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed without an explicit mapping and never applies suggestions', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    const planFile = path.join(root, 'review.plan.json');
    await writeFile(source, 'Key,Secret Value\nA,1\n');
    const fetch = vi.fn(async () => response(500, {}));
    vi.stubGlobal('fetch', fetch);
    const result = await runCommand([
      'env', 'import', 'plan', '--format', 'csv', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
      '--header-row', '1',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message).toContain('explicit header mapping');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies the reviewed plan, sends values only for writes, and writes a value-free receipt', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    const planFile = path.join(root, 'review.plan.json');
    const receiptFile = path.join(root, 'import.receipt.json');
    const nonce = 'A'.repeat(43);
    await writeFile(source, `Key,Secret Value\nAPI_TOKEN,${SECRET}\nSKIPPED,x\n`);
    const artifact = {
      schemaVersion: 1,
      kind: 'sift.vault.csv-import-plan',
      applyIdempotencyKey: 'csv-apply-idempotency-001',
      plan: {
        id: PLAN_ID,
        dialect: 'sift-csv-v1',
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        sourceNonce: nonce,
        sourceDigest: 'PLACEHOLDER',
        sourceProfile: {
          headerRowNumber: 1,
          delimiter: ',',
          columnCount: 2,
          dataRowCount: 2,
          mapping: {
            nameColumn: {index: 0, header: 'Key'},
            valueColumn: {index: 1, header: 'Secret Value'},
          },
        },
        planDigest: 'c'.repeat(64),
        items: [
          {
            sourceIndex: 0, key: 'API_TOKEN', rowNumber: 2, duplicateClass: 'none', rowClass: 'ok',
            conflictClass: 'none', proposedAction: 'create', targetName: 'API_TOKEN', targetSlug: 'api_token',
            existingEntryId: null, existingEntryType: null, existingValueRevision: null,
          },
          {
            sourceIndex: 1, key: 'SKIPPED', rowNumber: 3, duplicateClass: 'none', rowClass: 'ok',
            conflictClass: 'none', proposedAction: 'skip', targetName: 'SKIPPED', targetSlug: 'skipped',
            existingEntryId: null, existingEntryType: null, existingValueRevision: null,
          },
        ],
        status: 'active',
        expiresAt: '2026-09-11T12:00:00.000Z',
      },
    };
    const {createDotenvSourceBinding} = await import('../src/lib/dotenvImport.js');
    const binding = createDotenvSourceBinding(await readFile(source), nonce);
    artifact.plan.sourceDigest = binding.sourceDigest;
    await writeFile(planFile, JSON.stringify(artifact));

    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(200, {receipt: {
        planId: PLAN_ID,
        planDigest: 'c'.repeat(64),
        importId: '33333333-3333-4333-8333-333333333333',
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        skippedCount: 1,
        entries: [],
      }});
    }));

    const result = await runCommand([
      'env', 'import', 'apply', '--format', 'csv', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
      '--receipt-file', receiptFile, '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const sent = requestBody!.entries as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({sourceIndex: 0, key: 'API_TOKEN', valuePresent: true, value: SECRET});
    expect(sent[1]).toMatchObject({sourceIndex: 1, key: 'SKIPPED', valuePresent: false, value: ''});
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    expect(receipt).toMatchObject({kind: 'sift.vault.import-receipt', dialect: 'sift-csv-v1', importId: '33333333-3333-4333-8333-333333333333'});
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('refuses apply when the source drifted after planning', async () => {
    const root = await checkout();
    const source = path.join(root, 'legacy.csv');
    const planFile = path.join(root, 'review.plan.json');
    await writeFile(source, 'Key,Secret Value\nAPI_TOKEN,changed\n');
    const artifact = {
      schemaVersion: 1,
      kind: 'sift.vault.csv-import-plan',
      applyIdempotencyKey: 'csv-apply-drift-001',
      plan: {
        id: PLAN_ID,
        dialect: 'sift-csv-v1',
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        sourceNonce: 'A'.repeat(43),
        sourceDigest: '0'.repeat(64),
        sourceProfile: {
          headerRowNumber: 1, delimiter: ',', columnCount: 2, dataRowCount: 1,
          mapping: {nameColumn: {index: 0, header: 'Key'}, valueColumn: {index: 1, header: 'Secret Value'}},
        },
        planDigest: 'c'.repeat(64),
        items: [],
        status: 'active',
        expiresAt: '2026-09-11T12:00:00.000Z',
      },
    };
    await writeFile(planFile, JSON.stringify(artifact));
    const fetch = vi.fn(async () => response(200, {receipt: {}}));
    vi.stubGlobal('fetch', fetch);
    const result = await runCommand([
      'env', 'import', 'apply', '--format', 'csv', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
