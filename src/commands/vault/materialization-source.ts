export interface SafeMaterializationSource {
  [key: string]: unknown;
  id: string;
  name: string;
  slug: string;
  owner: string;
  qualifiedSlug: string;
  credentialFields: string[];
}

export function ownerFlagsForMaterializationSource<
  T extends {entry: string; owner?: string; workspace?: string},
>(flags: T): T {
  const reference = flags.entry.trim();
  const workspaceMatch = /^workspace:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i.exec(reference);
  const qualifiedOwner = reference.startsWith('personal/')
    ? 'personal'
    : workspaceMatch
      ? `workspace:${workspaceMatch[1]}`
      : null;
  if (!qualifiedOwner) return flags;
  if (flags.owner && flags.owner !== qualifiedOwner) {
    throw new Error(`--entry ${reference} conflicts with --owner ${flags.owner}.`);
  }
  const qualifiedWorkspace = qualifiedOwner.startsWith('workspace:')
    ? qualifiedOwner.slice('workspace:'.length)
    : null;
  if (flags.workspace && flags.workspace !== qualifiedWorkspace) {
    throw new Error(`--entry ${reference} conflicts with --workspace ${flags.workspace}.`);
  }
  return {...flags, owner: qualifiedOwner, workspace: qualifiedWorkspace ?? undefined};
}

export function assertCanonicalApprovalUrl(value: string, approvalId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Materialization response did not include an absolute approval URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/app/vault/approvals'
    || url.searchParams.get('approval') !== approvalId
    || [...url.searchParams.keys()].some(key => key !== 'approval')) {
    throw new Error('Materialization approval URL changed the exact approval binding.');
  }
  return url.toString();
}
