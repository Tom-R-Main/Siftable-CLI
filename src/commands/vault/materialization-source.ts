export interface SafeMaterializationSource {
  [key: string]: unknown;
  id: string;
  name: string;
  slug: string;
  owner: string;
  qualifiedSlug: string;
  credentialFields: string[];
  credentialFieldsResolved: boolean;
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

export function assertMaterializationSourceField(
  source: SafeMaterializationSource,
  field: string,
): void {
  if (source.credentialFieldsResolved && source.credentialFields.includes(field)) return;
  const validFields = source.credentialFields.length > 0
    ? source.credentialFields.map(value => JSON.stringify(value)).join(', ')
    : 'none';
  const recoveryCommand = 'sift vault materialize run --help';
  const error = new Error(
    `Vault field ${JSON.stringify(field)} is unavailable. Valid fields: ${validFields}\nRecovery: ${recoveryCommand}`,
  ) as Error & {
    api?: Record<string, unknown>;
    suggestions?: string[];
  };
  error.api = {
    type: 'vault_materialization_source_field_unavailable',
    extra: {
      retryable: false,
      recoveryCommand,
      validFields: source.credentialFields,
    },
  };
  error.suggestions = [recoveryCommand];
  throw error;
}

export async function withMaterializationRecovery<T>(
  operation: () => Promise<T>,
  options: {
    type: string;
    retryable: boolean;
    recoveryCommand: string;
  },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const recovered = error instanceof Error ? error : new Error(String(error));
    const apiError = recovered as Error & {
      api?: Record<string, unknown>;
      suggestions?: string[];
    };
    if (!recovered.message.startsWith('Not found:')) throw recovered;
    if (!recovered.message.includes(`Recovery: ${options.recoveryCommand}`)) {
      recovered.message = `${recovered.message}\nRecovery: ${options.recoveryCommand}`;
    }
    const existingExtra = apiError.api?.extra;
    apiError.api = {
      ...(apiError.api ?? {}),
      type: typeof apiError.api?.type === 'string' ? apiError.api.type : options.type,
      extra: {
        ...(existingExtra && typeof existingExtra === 'object' ? existingExtra : {}),
        retryable: options.retryable,
        recoveryCommand: options.recoveryCommand,
      },
    };
    apiError.suggestions = [options.recoveryCommand];
    throw recovered;
  }
}

export async function withMaterializationSourceRecovery<T>(
  operation: () => Promise<T>,
  reference: string,
  owner: string,
): Promise<T> {
  const recoveryCommand = `sift vault search ${JSON.stringify(reference)} --owner ${owner}`;
  return withMaterializationRecovery(operation, {
    type: 'vault_materialization_source_not_found',
    retryable: false,
    recoveryCommand,
  });
}
