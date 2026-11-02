import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseWorkDependencies} from '../../lib/work-dependencies.js';
import {
  WorkContractValidationError,
  defaultWorkContractActions,
  normalizeWorkContractProfile,
  requireBoundedWorkContract,
  requireBuiltWorkContract,
  type WorkContractCliProfile,
} from '../../lib/work-contract.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default class WorkCreate extends BaseCommand {
  static description = 'Create an executable agent work item';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Executable work item title', required: true}),
    prompt: Flags.string({description: 'Agent prompt or instructions'}),
    agent: Flags.string({description: 'Assigned agent alias'}),
    project: Flags.string({description: 'Linked project ID'}),
    task: Flags.string({description: 'Parent human planning task ID'}),
    rank: Flags.integer({description: 'Queue rank', default: 0}),
    context: Flags.string({description: 'Input context JSON object'}),
    'acceptance-criteria': Flags.string({description: 'Acceptance criteria JSON array or semicolon-separated text'}),
    'allowed-actions': Flags.string({description: 'Allowed actions JSON object'}),
    'write-scope': Flags.string({description: 'Write scope JSON object'}),
    verify: Flags.string({description: 'Verification commands separated by semicolons'}),
    profile: Flags.string({
      description: 'Author a complete Work Contract V1 using the coding or read-only profile',
      options: ['coding', 'read-only', 'read_only'],
    }),
    contract: Flags.string({description: 'Complete Work Contract V1 JSON'}),
    'contract-file': Flags.string({description: 'Path to a complete Work Contract V1 JSON file'}),
    scope: Flags.string({description: 'Included workspace-relative write scope; repeat for multiple paths', multiple: true}),
    'exclude-scope': Flags.string({description: 'Excluded workspace-relative write scope; repeat for multiple paths', multiple: true}),
    'allow-network': Flags.boolean({description: 'Allow network access in the authored contract'}),
    'allow-vault': Flags.boolean({description: 'Allow audited Vault access in the authored contract'}),
    'allow-deploy': Flags.boolean({description: 'Allow deployment in the authored contract'}),
    'allow-migrate': Flags.boolean({description: 'Allow migrations in the authored contract'}),
    'dry-run': Flags.boolean({description: 'Preview the normalized payload and contract without creating work'}),
    'depends-on': Flags.string({
      description: 'Dependency JSON array: [{"workItemId":"<uuid>","requiredGate"?:"done"|"commands_passed"}]',
    }),
    'capture-receipt': Flags.string({
      description: 'Finalized capture receipt UUID to bind atomically; repeat for multi-surface handoffs',
      multiple: true,
    }),
    'capture-applicability': Flags.string({
      description: 'Prospective capture applicability; this does not determine study eligibility',
      options: ['conversational_capture_required', 'non_conversational', 'unclassified'],
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkCreate);
    const acceptanceCriteria = flags['acceptance-criteria']?.trim().startsWith('[')
      ? this.parseJsonFlag<unknown[]>(flags['acceptance-criteria'], 'acceptance criteria')
      : flags['acceptance-criteria']?.split(';').map((text) => text.trim()).filter(Boolean).map((text) => ({text, met: false}));
    const allowedActionsFlag = this.parseJsonFlag<Record<string, unknown>>(flags['allowed-actions'], 'allowed actions');
    const writeScopeFlag = this.parseJsonFlag<Record<string, unknown>>(flags['write-scope'], 'write scope');
    const verificationCommands = flags.verify?.split(';').map((cmd) => cmd.trim()).filter(Boolean);
    const contractInput = this.parseJsonInput<unknown>(flags.contract, flags['contract-file'], 'contract');
    const profileFlag = flags.profile as WorkContractCliProfile | undefined;
    if (contractInput !== undefined && profileFlag) {
      this.error('Provide either --profile or --contract/--contract-file, not both.');
    }
    const projectionFlagsPresent = acceptanceCriteria !== undefined
      || allowedActionsFlag !== undefined
      || writeScopeFlag !== undefined
      || verificationCommands !== undefined
      || (flags.scope?.length ?? 0) > 0
      || (flags['exclude-scope']?.length ?? 0) > 0
      || flags['allow-network']
      || flags['allow-vault']
      || flags['allow-deploy']
      || flags['allow-migrate'];
    const profileOnlyFlagsPresent = (flags.scope?.length ?? 0) > 0
      || (flags['exclude-scope']?.length ?? 0) > 0
      || flags['allow-network']
      || flags['allow-vault']
      || flags['allow-deploy']
      || flags['allow-migrate'];
    if (contractInput !== undefined && projectionFlagsPresent) {
      this.error('A supplied contract is authoritative; remove acceptance, action, scope, and verification projection flags.');
    }
    if (!profileFlag && profileOnlyFlagsPresent) {
      this.error('--scope, --exclude-scope, and --allow-* require --profile.');
    }
    if (writeScopeFlag !== undefined && ((flags.scope?.length ?? 0) > 0 || (flags['exclude-scope']?.length ?? 0) > 0)) {
      this.error('Provide either --write-scope or --scope/--exclude-scope, not both.');
    }

    let contract;
    try {
      if (contractInput !== undefined) {
        contract = requireBoundedWorkContract(contractInput);
      } else if (profileFlag) {
        const profile = normalizeWorkContractProfile(profileFlag);
        let allowedActions: unknown = allowedActionsFlag === undefined
          ? defaultWorkContractActions(profile)
          : allowedActionsFlag;
        if (isRecord(allowedActions)) {
          const actionOverlay = {...allowedActions};
          if (flags['allow-network']) actionOverlay.network = true;
          if (flags['allow-vault']) actionOverlay.vault = true;
          if (flags['allow-deploy']) actionOverlay.deploy = true;
          if (flags['allow-migrate']) actionOverlay.migrate = true;
          allowedActions = actionOverlay;
        }
        const writeScope = writeScopeFlag === undefined
          ? {
              include: flags.scope ?? [],
              exclude: flags['exclude-scope'] ?? [],
            }
          : writeScopeFlag;
        contract = requireBuiltWorkContract({
          profile,
          acceptanceCriteria,
          allowedActions,
          writeScope,
          verificationCommands,
        });
      }
    } catch (error) {
      if (error instanceof WorkContractValidationError) this.error(error, {exit: 2});
      throw error;
    }
    if (flags['dry-run'] && !contract) {
      this.error('Contract preview requires --profile, --contract, or --contract-file.');
    }
    if (
      flags['capture-receipt']?.length
      && flags['capture-applicability']
      && flags['capture-applicability'] !== 'conversational_capture_required'
    ) {
      this.error('--capture-receipt requires --capture-applicability conversational_capture_required.');
    }
    let dependsOn;
    try {
      dependsOn = parseWorkDependencies(flags['depends-on']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid dependencies.');
    }
    const payload = {
      title: flags.title,
      prompt: flags.prompt,
      assignedAlias: flags.agent,
      projectId: flags.project,
      taskId: flags.task,
      queueRank: flags.rank,
      inputContext: this.parseJsonFlag<Record<string, unknown>>(flags.context, 'context'),
      ...(contract
        ? {contract}
        : {
            acceptanceCriteria,
            allowedActions: allowedActionsFlag,
            writeScope: writeScopeFlag,
            verificationCommands,
          }),
      dependsOn,
      captureReceiptIds: flags['capture-receipt'],
      captureApplicability: flags['capture-receipt']?.length
        ? 'conversational_capture_required' as const
        : flags['capture-applicability'] as 'conversational_capture_required' | 'non_conversational' | 'unclassified' | undefined,
    };
    if (flags['dry-run']) {
      return {
        ok: true,
        dryRun: true,
        workItem: payload,
        contract: {classification: 'bounded', normalized: contract},
      };
    }

    const client = await this.client(flags);
    const response = await client.createWorkItem(payload, this.idempotencyKey());
    this.handleApiError(response);
    const responseWithWarnings = response as typeof response & {warnings?: string[]};
    this.surfaceApiWarnings(responseWithWarnings);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`Work item created: ${workItem.id}`);
    }
    return responseWithWarnings.warnings?.length
      ? {...(response.data ?? {}), warnings: responseWithWarnings.warnings}
      : response.data;
  }
}
