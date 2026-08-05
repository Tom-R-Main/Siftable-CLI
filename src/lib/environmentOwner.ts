import type {EnvironmentOwner} from './environmentManifest.js';
import type {VaultOwnerContext} from './vault-owner-context.js';

export type ManifestOwnerFailureCode =
  | 'ambiguous_bare_slug'
  | 'grant_not_established'
  | 'owner_mismatch';

export type ManifestOwnerResolution =
  | {ok: true; owner: string}
  | {ok: false; code: ManifestOwnerFailureCode};

export function resolveManifestOwner(
  reference: string,
  owners: Readonly<Record<string, EnvironmentOwner>>,
): ManifestOwnerResolution {
  const declared = owners[reference];
  if (!declared) {
    return {ok: false, code: reference.includes('-') ? 'ambiguous_bare_slug' : 'grant_not_established'};
  }
  if (declared.owner_type === 'personal') {
    return {ok: true, owner: 'personal'};
  }
  return {ok: true, owner: `workspace:${declared.owner_id}`};
}

export interface AuthoritativeOwnerGrantEvidence {
  canonicalOwners: ReadonlySet<string>;
}

export function authorizeManifestOwner(
  reference: string,
  owners: Readonly<Record<string, EnvironmentOwner>>,
  context: VaultOwnerContext,
  evidence?: AuthoritativeOwnerGrantEvidence,
): ManifestOwnerResolution {
  const resolution = resolveManifestOwner(reference, owners);
  if (!resolution.ok) return resolution;
  const contextMatches = resolution.owner === 'personal'
    ? context.kind === 'user' && context.owner === 'personal'
    : context.kind === 'workspace' && context.owner === resolution.owner
      && context.workspaceId === resolution.owner.slice('workspace:'.length);
  if (!contextMatches) return {ok: false, code: 'owner_mismatch'};
  if (!evidence?.canonicalOwners.has(resolution.owner)) {
    return {ok: false, code: 'grant_not_established'};
  }
  return resolution;
}
