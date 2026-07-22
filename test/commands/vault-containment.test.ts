import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import VaultRead from '../../src/commands/vault/read.js';
import { hydrateProviderKeyFromVault } from '../../interactive-tui/commands.js';
import { createVaultTools as createSiftableVaultTools } from '../../interactive-tui/openfunction/providers/siftable/tools.js';
import { createVaultTools as createExecuFunctionVaultTools } from '../../interactive-tui/openfunction/providers/execufunction/tools.js';

describe('sift vault read containment', () => {
  it('retires the command through the real Oclif runner and generated manifest', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'oclif.manifest.json'), 'utf8')
    ) as { commands: Record<string, { description?: string }> };
    const result = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), 'bin/run.js'), 'vault', 'read', 'must-not-leak'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SIFT_API_URL: 'http://127.0.0.1:1',
          SIFT_TOKEN: 'sift_pat_must_not_leak',
        },
      }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Vault plaintext output is retired');
    expect(output).toContain('first-party Siftable web Vault');
    expect(output).not.toContain('sift_pat_must_not_leak');
    expect(output).not.toContain('must-not-leak');
    expect(manifest.commands['vault:read']?.description).toContain('Retired');
  });

  it('fails with migration guidance before creating an API request', async () => {
    global.fetch = vi.fn();
    const command = Object.create(VaultRead.prototype) as VaultRead;
    vi.spyOn(command as unknown as { parse: () => Promise<unknown> }, 'parse')
      .mockResolvedValue({ args: { id: 'secret-slug' }, flags: {} });
    vi.spyOn(command as unknown as { error: (message: string) => never }, 'error')
      .mockImplementation((message: string) => {
        throw new Error(message);
      });

    await expect(command.run()).rejects.toThrow('Vault plaintext output is retired');
    await expect(command.run()).rejects.toThrow('first-party Siftable web Vault');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not advertise raw decrypt in either interactive agent registry', () => {
    const client = { raw: () => ({}) };
    const registries = [
      createSiftableVaultTools(client as never),
      createExecuFunctionVaultTools(client as never),
    ];

    for (const tools of registries) {
      expect(tools.map((tool) => tool.name)).not.toContain('exf_vault_read_secret');
      expect(tools.map((tool) => tool.description).join(' ')).not.toContain('exf_vault_read_secret');
    }
  });

  it('retires interactive Vault hydration before making an API request', async () => {
    const previous = process.env.RETIRED_PROVIDER_API_KEY;
    delete process.env.RETIRED_PROVIDER_API_KEY;
    const apiClient = {
      listVaultEntries: vi.fn(),
      readVaultSecret: vi.fn(),
    };

    try {
      await expect(hydrateProviderKeyFromVault(
        { apiClient } as never,
        'retired-provider',
        'RETIRED_PROVIDER_API_KEY',
      )).resolves.toEqual(expect.objectContaining({
        ok: false,
        message: expect.stringContaining('Vault plaintext hydration'),
      }));
      expect(apiClient.listVaultEntries).not.toHaveBeenCalled();
      expect(apiClient.readVaultSecret).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.RETIRED_PROVIDER_API_KEY;
      else process.env.RETIRED_PROVIDER_API_KEY = previous;
    }
  });
});
