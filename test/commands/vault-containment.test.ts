import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { hydrateProviderKeyFromVault } from '../../interactive-tui/commands.js';
import { createVaultTools as createSiftableVaultTools } from '../../interactive-tui/openfunction/providers/siftable/tools.js';
import { createVaultTools as createExecuFunctionVaultTools } from '../../interactive-tui/openfunction/providers/execufunction/tools.js';

describe('Vault plaintext containment', () => {
  it('omits the legacy read command from the real Oclif runner and generated manifest', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'oclif.manifest.json'), 'utf8')
    ) as { commands: Record<string, { description?: string }> };
    const result = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), 'bin/run.js'), 'vault', 'read', 'legacy-entry'],
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

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/command vault:read:legacy-entry not found/i);
    expect(output).not.toContain('sift_pat_must_not_leak');
    expect(manifest.commands['vault:read']).toBeUndefined();
  });

  it('advertises governed single-field and environment materialization', () => {
    const vault = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), 'bin/run.js'), 'vault', '--help'],
      {cwd: process.cwd(), encoding: 'utf8'},
    );
    const materialize = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), 'bin/run.js'), 'vault', 'materialize', '--help'],
      {cwd: process.cwd(), encoding: 'utf8'},
    );
    const output = `${vault.stdout}\n${vault.stderr}\n${materialize.stdout}\n${materialize.stderr}`;

    expect(vault.status).toBe(0);
    expect(materialize.status).toBe(0);
    expect(output).toContain('vault materialize');
    expect(output).toContain('vault materialize run');
    expect(output).toContain('vault materialize environment');
    expect(output).not.toContain('vault read');
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
