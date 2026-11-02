import {describe, expect, it} from 'vitest';
import {resolveMaterializationRoot} from './materialization-root.js';

describe('materialization workspace root compatibility', () => {
  it('prefers the explicit local-only flag', () => {
    expect(resolveMaterializationRoot({'workspace-root': '/workspace'})).toEqual({
      workspaceRoot: '/workspace',
      usedLegacyAlias: false,
    });
  });

  it('accepts an absolute legacy alias for one compatibility window', () => {
    expect(resolveMaterializationRoot({workspace: '/legacy/workspace'})).toEqual({
      workspaceRoot: '/legacy/workspace',
      usedLegacyAlias: true,
    });
  });

  it('fails closed for ambiguous and relative values', () => {
    expect(() => resolveMaterializationRoot({workspace: '../workspace'})).toThrow(/must be absolute/);
    expect(() => resolveMaterializationRoot({workspace: 'tenant-id'})).toThrow(/Missing --workspace-root/);
    expect(() => resolveMaterializationRoot({workspace: '/legacy', 'workspace-root': '/current'})).toThrow(/both/);
  });
});
