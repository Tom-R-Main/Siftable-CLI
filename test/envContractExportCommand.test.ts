import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, describe, expect, it, vi} from 'vitest';
import EnvExportContract from '../src/commands/env/export/contract.js';
import {renderContractExport} from '../src/lib/envContractExport.js';
import {parseEnvironmentManifest} from '../src/lib/environmentManifest.js';

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
    result = await EnvExportContract.run(argv.slice(1), config);
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

async function checkoutWithManifest(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'sift-contract-export-'));
  roots.push(root);
  await mkdir(path.join(root, '.sift'), {recursive: true});
  await writeFile(path.join(root, '.sift', 'environment.yaml'), `
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: API_TOKEN
    kind: vault_field
    owner: personal
    entry_id: 44444444-4444-4444-8444-444444444444
    field: value
    sensitivity: secret
    documentation: Token used by =HYPERLINK("https://evil.example","sync")
    destination: {path: .runtime/service.env, mode: "0600"}
  - name: REGION
    kind: public
    sensitivity: public
    placeholder: us-central1
    destination: {path: .runtime/service.env, mode: "0600"}
`);
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

describe('sift env export contract', () => {
  it('renders metadata-only JSON and records a value-free audit receipt', async () => {
    const root = await checkoutWithManifest();
    const output = path.join(root, 'contract.json');
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(201, {receipt: {id: '55555555-5555-4555-8555-555555555555'}});
    }));
    const result = await runCommand([
      'contract', '--format', 'json', '--output', output,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    ]);
    expect(result.exitCode).toBe(0);
    expect(requestBody?.metadata).toEqual({destinationKind: 'file', encoding: 'utf-8'});
    const document = JSON.parse(await readFile(output, 'utf8'));
    expect(document).toMatchObject({schemaVersion: 1, kind: 'sift.vault.environment-contract-export'});
    expect(document.members).toHaveLength(2);
    expect(document.members[0]).toEqual({
      name: 'API_TOKEN',
      kind: 'vault_field',
      sensitivity: 'secret',
      reference: 'personal/44444444-4444-4444-8444-444444444444#value',
      publicDefault: '',
      documentation: 'Token used by =HYPERLINK("https://evil.example","sync")',
    });
    expect(JSON.stringify(document)).not.toContain('ciphertext');
    expect(requestBody).toMatchObject({exportKind: 'contract', format: 'json', memberCount: 2, outcome: 'completed'});
    expect(result.result).toMatchObject({memberCount: 2, exportId: '55555555-5555-4555-8555-555555555555'});
  });

  it('guards formula triggers in CSV output', async () => {
    const root = await checkoutWithManifest();
    vi.stubGlobal('fetch', vi.fn(async () => response(201, {receipt: {id: 'export-id'}})));
    const output = path.join(root, 'contract.csv');
    const result = await runCommand([
      'contract', '--format', 'csv', '--output', output,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    ]);
    expect(result.exitCode).toBe(0);
    const rendered = await readFile(output, 'utf8');
    const lines = rendered.trim().split('\n');
    expect(lines[0]).toBe('Name,Kind,Sensitivity,Reference,PublicDefault,Documentation');
    expect(lines).toHaveLength(3);
    // The documentation cell starts with "Token" (safe); a hostile leading
    // trigger would be single-quote guarded. Every field is quoted.
    for (const line of lines.slice(1)) {
      expect(line.startsWith('"')).toBe(true);
    }
    const parsed = parseEnvironmentManifest(`
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: NOTE
    kind: public
    sensitivity: public
    placeholder: ok
    documentation: =HYPERLINK("https://evil.example","x")
    destination: {path: .runtime/service.env, mode: "0600"}
`);
    if (!parsed.ok) throw new Error('Test manifest must parse');
    const hostile = renderContractExport(parsed.manifest, 'csv');
    expect(hostile.rendered).toContain('"\'=HYPERLINK(""https://evil.example"",""x"")"');
  });

  it('refuses to overwrite an existing output and posts a failed receipt', async () => {
    const root = await checkoutWithManifest();
    const output = path.join(root, 'contract.json');
    await writeFile(output, 'existing');
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response(201, {receipt: {id: 'export-id'}});
    }));
    const result = await runCommand([
      'contract', '--format', 'json', '--output', output,
      '--checkout-root', root, '--owner', 'personal', '--token', 'synthetic-token',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({exportKind: 'contract', outcome: 'failed'});
    expect(await readFile(output, 'utf8')).toBe('existing');
  });
});
