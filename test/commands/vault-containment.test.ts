import { describe, expect, it, vi } from 'vitest';
import VaultRead from '../../src/commands/vault/read.js';

describe('sift vault read containment', () => {
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
});
