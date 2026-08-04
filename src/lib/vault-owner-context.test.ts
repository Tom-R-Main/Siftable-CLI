import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {writeSavedWorkspaceSelection} from './workspace-context.js';
import {projectVaultEntries, resolveVaultOwnerContext, vaultApiFlags} from './vault-owner-context.js';

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const originalWorkspaceId = process.env.SIFT_WORKSPACE_ID;
const directories: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  if (originalWorkspaceId === undefined) delete process.env.SIFT_WORKSPACE_ID;
  else process.env.SIFT_WORKSPACE_ID = originalWorkspaceId;
  delete process.env.EXF_WORKSPACE_ID;
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('Vault owner context', () => {
  it('defaults to Personal and cuts a saved workspace over to request transport', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-vault-owner-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    delete process.env.SIFT_WORKSPACE_ID;
    expect(resolveVaultOwnerContext({})).toMatchObject({
      kind: 'user',
      owner: 'personal',
      workspaceId: null,
      contextContractVersion: 1,
    });
    writeSavedWorkspaceSelection({
      workspaceId: 'workspace-saved',
      workspaceName: 'Saved',
      selectedAt: '2026-08-04T00:00:00.000Z',
    });
    const selected = resolveVaultOwnerContext({});
    expect(selected).toMatchObject({
      kind: 'workspace',
      owner: 'workspace:workspace-saved',
      selectionSource: 'saved_selection',
    });
    expect(vaultApiFlags({token: 'opaque'}, selected)).toEqual({
      token: 'opaque',
      'api-url': undefined,
      workspace: 'workspace-saved',
    });
  });

  it('supports explicit owner overrides without silently mixing context', () => {
    process.env.SIFT_WORKSPACE_ID = 'workspace-env';
    expect(resolveVaultOwnerContext({owner: 'personal'})).toMatchObject({
      owner: 'personal',
      workspaceId: null,
      selectionSource: 'owner_flag',
    });
    expect(resolveVaultOwnerContext({owner: 'workspace:workspace-explicit'})).toMatchObject({
      owner: 'workspace:workspace-explicit',
      workspaceId: 'workspace-explicit',
    });
    expect(() => resolveVaultOwnerContext({owner: 'personal', workspace: 'workspace-1'})).toThrow(/exactly one/);
    expect(() => resolveVaultOwnerContext({owner: 'workspace:/tmp/local'})).toThrow(/not a path/);
    expect(() => resolveVaultOwnerContext({owner: 'organization-1'})).toThrow(/personal or workspace/);
  });

  it('keeps the deprecated absolute materialization alias Personal and v0', () => {
    process.env.SIFT_WORKSPACE_ID = 'workspace-env';
    expect(resolveVaultOwnerContext({workspace: '/legacy/root'}, {legacyMaterializationAlias: true})).toMatchObject({
      owner: 'personal',
      workspaceId: null,
      contextContractVersion: 0,
      selectionSource: 'legacy_materialization_alias',
    });
    expect(() => resolveVaultOwnerContext(
      {workspace: '/legacy/root', owner: 'workspace:workspace-1'},
      {legacyMaterializationAlias: true},
    )).toThrow(/Personal-only/);
  });

  it('projects only safe metadata and reports the persisted owner', () => {
    const owner = resolveVaultOwnerContext({owner: 'workspace:workspace-1'});
    const [entry] = projectVaultEntries([{
      id: 'entry-1',
      name: 'Provider key',
      slug: 'provider_key',
      entryType: 'env_var',
      ownerType: 'workspace',
      ownerId: 'workspace-1',
      ownerProvenance: 'explicit',
      encryptedPayload: 'SENTINEL_CIPHERTEXT',
      payload: {value: 'SENTINEL_PLAINTEXT'},
      nonce: 'SENTINEL_NONCE',
    }], owner);
    expect(entry).toMatchObject({
      id: 'entry-1',
      owner: 'workspace:workspace-1',
      ownerType: 'workspace',
      qualifiedSlug: 'workspace:workspace-1/provider_key',
    });
    expect(entry).not.toHaveProperty('payload');
    expect(entry).not.toHaveProperty('encryptedPayload');
    expect(entry).not.toHaveProperty('nonce');
  });

  it('fails closed on cross-owner results with executable owner alternatives', () => {
    const requested = resolveVaultOwnerContext({owner: 'personal'});
    expect(() => projectVaultEntries([
      {id: 'personal-1', slug: 'shared', ownerType: 'user', ownerId: 'user-1'},
      {id: 'workspace-1', slug: 'shared', ownerType: 'workspace', ownerId: 'workspace-1'},
    ], requested)).toThrow(/sift vault search.*--owner personal.*--owner workspace:workspace-1/);
    expect(() => projectVaultEntries([
      {id: 'workspace-1', slug: 'other', ownerType: 'workspace', ownerId: 'workspace-1'},
    ], requested)).toThrow(/crossed the requested personal owner boundary/);
  });

  it('keeps legacy null-owner rows discoverable only in Personal', () => {
    const personal = resolveVaultOwnerContext({owner: 'personal'});
    expect(projectVaultEntries([
      {id: 'legacy-1', slug: 'legacy', ownerType: null, ownerId: null, contextContractVersion: 0},
    ], personal)[0]).toMatchObject({
      owner: 'personal',
      ownerType: 'user',
      ownerProvenance: 'legacy_v0',
      contextContractVersion: 0,
    });
    const workspace = resolveVaultOwnerContext({owner: 'workspace:workspace-1'});
    expect(() => projectVaultEntries([
      {id: 'legacy-1', slug: 'legacy', ownerType: null, ownerId: null},
    ], workspace)).toThrow(/unresolved owner/);
  });
});
