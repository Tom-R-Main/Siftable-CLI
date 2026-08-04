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
>(flags: T, options: {legacyMaterializationAlias?: boolean} = {}): T {
  const reference = flags.entry.trim();
  const workspaceMatch = /^workspace:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i.exec(reference);
  const qualifiedOwner = reference.startsWith('personal/')
    ? 'personal'
    : workspaceMatch
      ? `workspace:${workspaceMatch[1]}`
      : null;
  if (!qualifiedOwner) return flags;
  if (options.legacyMaterializationAlias) {
    if (qualifiedOwner !== 'personal') {
      throw new Error('The deprecated path-shaped --workspace alias is Personal-only. Use --workspace-root with --owner workspace:<tenant-id>.');
    }
    return {...flags, owner: 'personal', workspace: undefined};
  }
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

export async function withMaterializationSourceRecovery<T>(
  operation: () => Promise<T>,
  reference: string,
  owner: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const recoveryCommand = `sift vault search ${JSON.stringify(reference)} --owner ${owner}`;
    const recovered = error instanceof Error ? error : new Error(String(error));
    const apiError = recovered as Error & {
      api?: Record<string, unknown>;
      suggestions?: string[];
    };
    const existingType = typeof apiError.api?.type === 'string' ? apiError.api.type : undefined;
    if (existingType === 'vault_materialization_source_not_found'
      || recovered.message.startsWith('Not found:')) {
      recovered.message = `${recovered.message}\nRecovery: ${recoveryCommand}`;
      apiError.api = {
        ...(apiError.api ?? {}),
        type: 'vault_materialization_source_not_found',
        extra: {
          retryable: false,
          recoveryCommand,
        },
      };
      apiError.suggestions = [recoveryCommand];
    }
    throw recovered;
  }
}
