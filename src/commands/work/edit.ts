import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {AGENT_WORK_EDIT_CAPABILITY} from '../../lib/work-edit-contract.js';

type WorkEditPatch = {
  title?: string;
  prompt?: string | null;
  queueRank?: number;
  inputContext?: Record<string, unknown>;
  acceptanceCriteria?: unknown[];
  allowedActions?: Record<string, unknown>;
  writeScope?: Record<string, unknown>;
  verificationCommands?: string[];
  contract?: unknown;
};

type WorkEditPreservation = {
  identity: {
    workItemIdUnchanged: true;
    projectIdUnchanged: true;
    taskIdUnchanged: true;
    assignedAliasIdUnchanged: true;
    createdAtUnchanged: true;
  };
  lifecycle: {statusUnchanged: true; claimUnchanged: true};
  dependencies: {incomingEdgesUnchanged: true; outgoingEdgesUnchanged: true};
};

export default class WorkEdit extends BaseCommand {
  static description = [
    `${AGENT_WORK_EDIT_CAPABILITY.commitmentClass}: ${AGENT_WORK_EDIT_CAPABILITY.useWhen}`,
    AGENT_WORK_EDIT_CAPABILITY.doNotUseWhen,
    AGENT_WORK_EDIT_CAPABILITY.example,
    AGENT_WORK_EDIT_CAPABILITY.counterexample,
    AGENT_WORK_EDIT_CAPABILITY.sideEffects,
    AGENT_WORK_EDIT_CAPABILITY.duplicateBehavior,
  ].join(' ');

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'expected-revision': Flags.integer({description: 'Observed work item revision', required: true, min: 1}),
    reason: Flags.string({description: 'Auditable reason for the revision', required: true}),
    'idempotency-key': Flags.string({description: 'Stable retry key for this exact edit', required: true}),
    'dry-run': Flags.boolean({description: 'Show normalized diff and proof consequences without mutating'}),
    patch: Flags.string({description: 'Editable fields as one JSON object'}),
    'patch-file': Flags.string({description: 'Path to an editable-fields JSON object'}),
    title: Flags.string({description: 'Replacement title'}),
    prompt: Flags.string({description: 'Replacement prompt; use --patch for null'}),
    rank: Flags.integer({description: 'Replacement queue rank'}),
    context: Flags.string({description: 'Replacement input context JSON object'}),
    'acceptance-criteria': Flags.string({description: 'Replacement acceptance criteria JSON array'}),
    'allowed-actions': Flags.string({description: 'Replacement allowed actions JSON object'}),
    'write-scope': Flags.string({description: 'Replacement write scope JSON object'}),
    verify: Flags.string({description: 'Replacement verification commands as JSON array or semicolon-separated text'}),
    contract: Flags.string({description: 'Replacement Work Contract V1 JSON'}),
    'contract-file': Flags.string({description: 'Path to replacement Work Contract V1 JSON'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkEdit);
    const patch = this.parseJsonInput<WorkEditPatch>(flags.patch, flags['patch-file'], 'patch') ?? {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) this.error('Patch must be a JSON object.');
    const direct: WorkEditPatch = {
      ...(flags.title !== undefined ? {title: flags.title} : {}),
      ...(flags.prompt !== undefined ? {prompt: flags.prompt} : {}),
      ...(flags.rank !== undefined ? {queueRank: flags.rank} : {}),
      ...(flags.context !== undefined
        ? {inputContext: this.parseJsonFlag<Record<string, unknown>>(flags.context, 'context')}
        : {}),
      ...(flags['acceptance-criteria'] !== undefined
        ? {acceptanceCriteria: this.parseJsonFlag<unknown[]>(flags['acceptance-criteria'], 'acceptance criteria')}
        : {}),
      ...(flags['allowed-actions'] !== undefined
        ? {allowedActions: this.parseJsonFlag<Record<string, unknown>>(flags['allowed-actions'], 'allowed actions')}
        : {}),
      ...(flags['write-scope'] !== undefined
        ? {writeScope: this.parseJsonFlag<Record<string, unknown>>(flags['write-scope'], 'write scope')}
        : {}),
      ...(flags.verify !== undefined
        ? {
            verificationCommands: flags.verify.trim().startsWith('[')
              ? this.parseJsonFlag<string[]>(flags.verify, 'verification commands')
              : flags.verify.split(';').map((command) => command.trim()).filter(Boolean),
          }
        : {}),
      ...((flags.contract !== undefined || flags['contract-file'] !== undefined)
        ? {contract: this.parseJsonInput<unknown>(flags.contract, flags['contract-file'], 'contract')}
        : {}),
    };
    const duplicates = Object.keys(direct).filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
    if (duplicates.length > 0) {
      this.error(`Provide each editable field once; duplicated in patch and flags: ${duplicates.join(', ')}.`);
    }
    const normalizedPatch = {...patch, ...direct};
    if (Object.keys(normalizedPatch).length === 0) {
      this.error('Provide at least one editable field or a non-empty --patch/--patch-file.');
    }

    const result = await this.apiRequest<{
      workItem: Record<string, unknown>;
      receipt: Record<string, unknown>;
      diff: Record<string, unknown>;
      preservation: WorkEditPreservation;
      dryRun: boolean;
      replayed: boolean;
    }>(flags, `/api/v1/work-items/${args.id}`, {
      method: 'PATCH',
      idempotencyKey: flags['idempotency-key'],
      body: {
        ...normalizedPatch,
        expectedRevision: flags['expected-revision'],
        reason: flags.reason,
        dryRun: flags['dry-run'] || undefined,
      },
    });
    if (!this.jsonEnabled()) {
      const receipt = result.receipt;
      const changedFields = Array.isArray(receipt.changedFields) ? receipt.changedFields.join(', ') : 'none';
      const mode = result.dryRun ? 'Dry run' : result.replayed ? 'Replayed edit' : 'Work item edited';
      this.log(`${mode}: ${result.workItem.id}`);
      this.log(`Revision: ${receipt.previousRevision} -> ${receipt.revision}`);
      this.log(`Changed: ${changedFields || 'none'}`);
      this.log(`Verification invalidated: ${receipt.verificationInvalidated ? 'yes' : 'no'}`);
      this.log('Preserved: identity, lifecycle and incoming/outgoing dependency edges');
    }
    return result;
  }
}
