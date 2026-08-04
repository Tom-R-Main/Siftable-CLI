import {describe, expect, it, vi} from 'vitest';
import Capabilities from './capabilities.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('static readiness capabilities', () => {
  it('declares a non-executable surface distinct from Vault capability handles', async () => {
    const instance = command(Capabilities);
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {}});
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(result.kind).toBe('static_readiness');
    expect(result.selection).toEqual({
      command: 'sift capabilities',
      executable: false,
      executableHandleSurface: 'sift capabilities list',
    });
    expect(result.capabilities.every((capability: any) => capability.kind === 'static_readiness')).toBe(true);
  });
});
