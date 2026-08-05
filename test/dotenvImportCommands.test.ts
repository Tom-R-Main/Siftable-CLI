import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import EnvImportApply from '../src/commands/env/import/apply.js';
import EnvImportPlan from '../src/commands/env/import/plan.js';

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
  const root = await mkdtemp(path.join(tmpdir(), 'sift-dotenv-import-'));
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

describe('sift env import plan/apply', () => {
  it('keeps values local during planning and writes a value-free exclusive artifact', async () => {
    const root = await checkout();
    const source = path.join(root, 'input.env');
    const planFile = path.join(root, 'review.plan.json');
    const secret = 'synthetic-secret-never-plan';
    await writeFile(source, `TOKEN=${secret}\n`);
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: HeadersInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = init?.headers;
      const entries = requestBody.entries as Array<Record<string, unknown>>;
      return response(201, {plan: {
        id: '22222222-2222-4222-8222-222222222222',
        dialect: requestBody.dialect,
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        sourceNonce: requestBody.sourceNonce,
        sourceDigest: requestBody.sourceDigest,
        planDigest: 'c'.repeat(64),
        items: entries.map((entry) => ({
          ...entry,
          conflictClass: 'none',
          proposedAction: 'create',
          targetSlug: 'token',
          existingEntryId: null,
        })),
        status: 'active',
        expiresAt: '2026-08-05T22:00:00.000Z',
      }});
    }));

    const result = await runCommand([
      'env', 'import', 'plan', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({kind: 'sift.vault.dotenv-import-plan'});
    expect(JSON.parse(result.stdout)).toMatchObject({kind: 'sift.vault.dotenv-import-plan'});
    expect(JSON.stringify(requestBody)).not.toContain(secret);
    expect((requestHeaders as Record<string, string>)['Idempotency-Key']).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(result.stdout).not.toContain(secret);
    expect(await readFile(planFile, 'utf8')).not.toContain(secret);
    expect(await readFile(source, 'utf8')).toBe(`TOKEN=${secret}\n`);

    const second = await runCommand([
      'env', 'import', 'plan', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(second.exitCode).not.toBe(0);
  });

  it('re-reads the explicit source and sends values only to exact-plan apply', async () => {
    const root = await checkout();
    const source = path.join(root, 'input.env');
    const planFile = path.join(root, 'review.plan.json');
    const secret = 'synthetic-apply-only';
    const skippedSecret = 'synthetic-stays-local';
    await writeFile(source, `TOKEN=${secret}\nSKIPPED=${skippedSecret}\n`);
    let applyBody: Record<string, unknown> | undefined;
    let planned: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname === '/api/v1/vault/import-plans') {
        const entries = body.entries as Array<Record<string, unknown>>;
        planned = {
          id: '22222222-2222-4222-8222-222222222222', dialect: body.dialect,
          ownerType: 'user', ownerId: '11111111-1111-4111-8111-111111111111', projectId: null,
          sourceNonce: body.sourceNonce, sourceDigest: body.sourceDigest, planDigest: 'd'.repeat(64),
          items: entries.map((entry, index) => ({
            ...entry,
            conflictClass: index === 0 ? 'none' : 'source_duplicate',
            proposedAction: index === 0 ? 'create' : 'skip',
            targetName: entry.key,
            targetSlug: index === 0 ? 'token' : 'skipped',
            existingEntryId: null,
          })),
          status: 'active', expiresAt: '2026-08-05T22:00:00.000Z',
        };
        return response(201, {plan: planned});
      }
      applyBody = body;
      return response(200, {receipt: {
        planId: planned!.id, planDigest: planned!.planDigest, importId: '33333333-3333-4333-8333-333333333333',
        ownerType: 'user', ownerId: planned!.ownerId, projectId: null,
        createdCount: 1, updatedCount: 0, keptCount: 0, skippedCount: 1,
        entries: [
          {sourceIndex: 0, key: 'TOKEN', action: 'create', slug: 'token', entryId: '44444444-4444-4444-8444-444444444444', field: 'value'},
          {sourceIndex: 1, key: 'SKIPPED', action: 'skip', slug: 'skipped', entryId: null, field: 'value'},
        ],
      }});
    }));
    const planResult = await runCommand([
      'env', 'import', 'plan', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(planResult.exitCode).toBe(0);
    const applyResult = await runCommand([
      'env', 'import', 'apply', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(applyResult.exitCode).toBe(0);
    expect(JSON.parse(applyResult.stdout)).toMatchObject({
      importId: '33333333-3333-4333-8333-333333333333',
    });
    expect(JSON.stringify(applyBody)).toContain(secret);
    expect(JSON.stringify(applyBody)).not.toContain(skippedSecret);
    expect((applyBody!.entries as Array<{
      sourceIndex: number;
      key: string;
      valuePresent: boolean;
      value: string;
    }>)).toContainEqual({sourceIndex: 0, key: 'TOKEN', valuePresent: true, value: secret});
    expect((applyBody!.entries as Array<{
      sourceIndex: number;
      key: string;
      valuePresent: boolean;
      value: string;
    }>)).toContainEqual({
      sourceIndex: 1,
      key: 'SKIPPED',
      valuePresent: false,
      value: '',
    });
    expect(applyResult.stdout).not.toContain(secret);
    expect(applyResult.stdout).not.toContain(skippedSecret);
    expect(await readFile(source, 'utf8')).toBe(`TOKEN=${secret}\nSKIPPED=${skippedSecret}\n`);
  });

  it('rejects changed and Sift-managed sources before an apply or plan request', async () => {
    const root = await checkout();
    const source = path.join(root, 'input.env');
    const planFile = path.join(root, 'review.plan.json');
    await writeFile(source, 'TOKEN=first\n');
    let planned: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const entries = body.entries as Array<Record<string, unknown>>;
      planned = {
        id: '22222222-2222-4222-8222-222222222222', dialect: body.dialect,
        ownerType: 'user', ownerId: '11111111-1111-4111-8111-111111111111', projectId: null,
        sourceNonce: body.sourceNonce, sourceDigest: body.sourceDigest, planDigest: 'e'.repeat(64),
        items: entries.map((entry) => ({...entry, conflictClass: 'none', proposedAction: 'create', targetSlug: 'token', existingEntryId: null})),
        status: 'active', expiresAt: '2026-08-05T22:00:00.000Z',
      };
      return response(201, {plan: planned});
    });
    vi.stubGlobal('fetch', fetch);
    expect((await runCommand([
      'env', 'import', 'plan', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ])).exitCode).toBe(0);
    await writeFile(source, 'TOKEN=second\n');
    const changed = await runCommand([
      'env', 'import', 'apply', '--source', source, '--plan-file', planFile,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(changed.exitCode).not.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    const managedRoot = await checkout();
    await mkdir(path.join(managedRoot, '.sift'), {recursive: true});
    await mkdir(path.join(managedRoot, '.runtime'), {recursive: true});
    const managedSource = path.join(managedRoot, '.runtime', 'service.env');
    await writeFile(managedSource, 'TOKEN=managed\n');
    await writeFile(path.join(managedRoot, '.sift', 'environment.yaml'), `
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: TOKEN
    kind: vault_field
    owner: personal
    entry_id: 44444444-4444-4444-8444-444444444444
    field: value
    sensitivity: secret
    destination: {path: .runtime/service.env, mode: "0600"}
`);
    const managed = await runCommand([
      'env', 'import', 'plan', '--source', managedSource, '--plan-file', path.join(managedRoot, 'managed.plan.json'),
      '--checkout-root', managedRoot, '--owner', 'personal', '--token', 'synthetic-token', '--json',
    ]);
    expect(managed.exitCode).not.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    const unrelatedRoot = await checkout();
    const bypass = await runCommand([
      'env', 'import', 'plan', '--source', managedSource,
      '--plan-file', path.join(managedRoot, 'bypass.plan.json'),
      '--checkout-root', unrelatedRoot, '--owner', 'personal',
      '--token', 'synthetic-token', '--json',
    ]);
    expect(bypass.exitCode).not.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
