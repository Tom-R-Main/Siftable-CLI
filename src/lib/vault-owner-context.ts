import {Flags} from '@oclif/core';
import type {ApiContextFlags} from './base-command.js';
import {looksLikeLocalPath, resolveContextSelection} from './workspace-context.js';

export type VaultOwnerKind = 'user' | 'workspace';

export interface VaultOwnerContext {
  kind: VaultOwnerKind;
  owner: string;
  workspaceId: string | null;
  contextContractVersion: 0 | 1;
  selectionSource: string;
}

export const vaultOwnerFlag = Flags.string({
  description: 'Exact Vault owner: personal or workspace:<tenant-id>',
  helpValue: 'personal|workspace:<tenant-id>',
});

function workspaceOwnerId(value: string): string | null {
  if (!value.startsWith('workspace:')) return null;
  const workspaceId = value.slice('workspace:'.length).trim();
  if (!workspaceId || looksLikeLocalPath(workspaceId)) {
    throw new Error('--owner workspace:<tenant-id> requires an exact collaborative tenant ID, not a path.');
  }
  return workspaceId;
}

export function resolveVaultOwnerContext(
  flags: {owner?: string; workspace?: string},
  options: {legacyMaterializationAlias?: boolean} = {},
): VaultOwnerContext {
  if (options.legacyMaterializationAlias) {
    if (flags.owner && flags.owner.trim() !== 'personal') {
      throw new Error('The deprecated path-shaped --workspace alias is Personal-only. Use --workspace-root with --owner workspace:<tenant-id>.');
    }
    return {
      kind: 'user',
      owner: 'personal',
      workspaceId: null,
      contextContractVersion: 0,
      selectionSource: 'legacy_materialization_alias',
    };
  }

  const explicitOwner = flags.owner?.trim();
  if (explicitOwner) {
    if (explicitOwner === 'personal') {
      if (flags.workspace) {
        throw new Error('Do not combine --owner personal with --workspace. Choose exactly one Vault owner.');
      }
      return {
        kind: 'user',
        owner: 'personal',
        workspaceId: null,
        contextContractVersion: 1,
        selectionSource: 'owner_flag',
      };
    }
    const workspaceId = workspaceOwnerId(explicitOwner);
    if (!workspaceId) {
      throw new Error('--owner must be personal or workspace:<tenant-id>.');
    }
    if (flags.workspace && flags.workspace !== workspaceId) {
      throw new Error('--owner and --workspace identify different collaborative tenants. Choose exactly one.');
    }
    return {
      kind: 'workspace',
      owner: `workspace:${workspaceId}`,
      workspaceId,
      contextContractVersion: 1,
      selectionSource: 'owner_flag',
    };
  }

  const selection = resolveContextSelection({workspaceFlag: flags.workspace});
  if (selection.selectedWorkspaceId) {
    return {
      kind: 'workspace',
      owner: `workspace:${selection.selectedWorkspaceId}`,
      workspaceId: selection.selectedWorkspaceId,
      contextContractVersion: 1,
      selectionSource: selection.selectionSource,
    };
  }
  return {
    kind: 'user',
    owner: 'personal',
    workspaceId: null,
    contextContractVersion: 1,
    selectionSource: selection.selectionSource,
  };
}

export function vaultApiFlags(
  flags: ApiContextFlags & {owner?: string},
  context: VaultOwnerContext,
): ApiContextFlags {
  return {
    token: flags.token,
    'api-url': flags['api-url'],
    workspace: context.workspaceId,
  };
}

const SAFE_VAULT_ENTRY_FIELDS = [
  'id',
  'name',
  'slug',
  'description',
  'entryType',
  'scope',
  'projectId',
  'url',
  'tags',
  'category',
  'expiresAt',
  'lastRotatedAt',
  'lastAccessedAt',
  'isArchived',
  'importBatchId',
  'createdAt',
  'updatedAt',
] as const;

function effectiveEntryOwner(
  entry: Record<string, unknown>,
  requested: VaultOwnerContext,
): {owner: string; ownerType: VaultOwnerKind; ownerId: string | null; ownerProvenance: string} {
  if (entry.ownerType === 'workspace' && typeof entry.ownerId === 'string' && entry.ownerId) {
    return {
      owner: `workspace:${entry.ownerId}`,
      ownerType: 'workspace',
      ownerId: entry.ownerId,
      ownerProvenance: typeof entry.ownerProvenance === 'string' ? entry.ownerProvenance : 'explicit',
    };
  }
  if (entry.ownerType === 'user') {
    return {
      owner: 'personal',
      ownerType: 'user',
      ownerId: typeof entry.ownerId === 'string' ? entry.ownerId : null,
      ownerProvenance: typeof entry.ownerProvenance === 'string' ? entry.ownerProvenance : 'explicit',
    };
  }
  if (entry.ownerType == null && entry.ownerId == null && requested.kind === 'user') {
    return {
      owner: 'personal',
      ownerType: 'user',
      ownerId: null,
      ownerProvenance: 'legacy_v0',
    };
  }
  throw new Error('Vault metadata returned an unresolved owner and was rejected.');
}

export function projectVaultEntries(
  entries: Record<string, unknown>[],
  requested: VaultOwnerContext,
): Record<string, unknown>[] {
  const projected: Record<string, unknown>[] = entries.map((entry) => {
    const actual = effectiveEntryOwner(entry, requested);
    const safe = Object.fromEntries(
      SAFE_VAULT_ENTRY_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(entry, field))
        .map((field) => [field, entry[field]]),
    );
    const slug = typeof entry.slug === 'string' ? entry.slug : null;
    return {
      ...safe,
      ...actual,
      contextContractVersion: entry.contextContractVersion ?? (actual.ownerProvenance === 'legacy_v0' ? 0 : 1),
      qualifiedSlug: slug ? `${actual.owner}/${slug}` : null,
    };
  });

  const owners = new Set(projected.map((entry) => String(entry.owner)));
  const ownerBySlug = new Map<string, Set<string>>();
  for (const entry of projected) {
    if (typeof entry.slug !== 'string') continue;
    const slugOwners = ownerBySlug.get(entry.slug) ?? new Set<string>();
    slugOwners.add(String(entry.owner));
    ownerBySlug.set(entry.slug, slugOwners);
  }
  for (const [slug, slugOwners] of ownerBySlug) {
    if (slugOwners.size > 1) {
      const alternatives = [...slugOwners]
        .sort()
        .map((owner) => `sift vault search ${JSON.stringify(slug)} --owner ${owner}`)
        .join(' or ');
      throw new Error(`Vault slug ${JSON.stringify(slug)} is ambiguous across owners. Use ${alternatives}.`);
    }
  }
  if (owners.size > 1 || (owners.size === 1 && !owners.has(requested.owner))) {
    throw new Error(`Vault metadata crossed the requested ${requested.owner} owner boundary and was rejected.`);
  }
  return projected;
}
