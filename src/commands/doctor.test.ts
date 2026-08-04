import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import Doctor from './doctor.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const directories: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  delete process.env.SIFT_WORKSPACE_ID;
  delete process.env.EXF_WORKSPACE_ID;
  delete process.env.SIFT_TOKEN;
  delete process.env.EXF_TOKEN;
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('doctor Personal semantics', () => {
  it('marks workspace service-token setup not applicable in healthy Personal context', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-doctor-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    const instance = command(Doctor);
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {token: 'opaque-token'}});
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(result.ok).toBe(true);
    expect(result.workspace).toBeNull();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'workspace_service_token_setup',
      ok: true,
      status: 'not applicable (Personal context)',
    }));
  });

  it('fails with recovery when a local path is supplied as a workspace tenant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-doctor-path-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    const instance = command(Doctor);
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {
      token: 'opaque-token',
      workspace: '/local/checkout',
    }});
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'workspace',
      ok: false,
      next: expect.stringContaining('--workspace-root'),
    }));
  });
});
