import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {createDotenvSourceBinding, parseDotenvImport} from '../../../lib/dotenvImport.js';
import {
  assertDotenvSourceIsNotManaged,
  readDotenvImportPlanArtifact,
  readExplicitDotenvSource,
  resolveDotenvImportCheckoutRoot,
} from '../../../lib/dotenvImportPlan.js';
import type {DotenvImportApplyResponse} from '../../../lib/dotenvImportTypes.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class EnvImportApply extends BaseCommand {
  static summary = 'Apply one exact reviewed dotenv import plan atomically';
  static description = 'Re-reads and re-parses the explicitly named source, rejects any source or plan drift, and sends values only to the transactional apply endpoint.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    source: Flags.string({required: true, description: 'Same explicit dotenv source used to create the plan'}),
    'plan-file': Flags.string({required: true, description: 'Reviewed value-free plan artifact'}),
    'checkout-root': Flags.string({description: 'Checkout used only to reject Sift-managed source files'}),
  };

  async run(): Promise<DotenvImportApplyResponse['receipt']> {
    const {flags} = await this.parse(EnvImportApply);
    const source = await readExplicitDotenvSource(flags.source);
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(source.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(source.path, checkoutRoot);
    const artifact = await readDotenvImportPlanArtifact(flags['plan-file']);
    const parsed = parseDotenvImport(source.raw);
    const rebound = createDotenvSourceBinding(source.raw, artifact.plan.sourceNonce);
    if (rebound.sourceDigest !== artifact.plan.sourceDigest) {
      this.error('Dotenv source changed after planning. Create and review a new plan.');
    }
    const plannedByIndex = new Map(artifact.plan.items.map((item) => [item.sourceIndex, item]));
    if (parsed.entries.length !== artifact.plan.items.length || parsed.entries.some((entry) => {
      const planned = plannedByIndex.get(entry.sourceIndex);
      return !planned || planned.key !== entry.key || planned.line !== entry.line
        || planned.column !== entry.column || planned.duplicateClass !== entry.duplicateClass;
    })) {
      this.error('Dotenv source structure changed after planning. Create and review a new plan.');
    }
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    if (artifact.plan.ownerType !== owner.kind
      || (owner.kind === 'workspace' && artifact.plan.ownerId !== owner.workspaceId)) {
      this.error('Selected Vault owner does not match the reviewed import plan.');
    }
    const response = await this.apiRequest<DotenvImportApplyResponse>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/import-plans/${encodeURIComponent(artifact.plan.id)}/apply`,
      {
        method: 'POST',
        body: {
          planDigest: artifact.plan.planDigest,
          sourceNonce: artifact.plan.sourceNonce,
          sourceDigest: rebound.sourceDigest,
          entries: parsed.entries.map(({sourceIndex, key, value}) => {
            const action = plannedByIndex.get(sourceIndex)!.proposedAction;
            const writesValue = action === 'create' || action === 'rename' || action === 'overwrite';
            return {sourceIndex, key, value: writesValue ? value : ''};
          }),
        },
      },
    );
    if (response.receipt.planId !== artifact.plan.id
      || response.receipt.planDigest !== artifact.plan.planDigest
      || response.receipt.ownerType !== artifact.plan.ownerType
      || response.receipt.ownerId !== artifact.plan.ownerId
      || response.receipt.projectId !== artifact.plan.projectId) {
      this.error('Server dotenv import receipt does not match the reviewed plan binding.');
    }
    if (!this.jsonEnabled()) {
      this.log(`Applied ${response.receipt.importId}: ${response.receipt.createdCount} created, ${response.receipt.updatedCount} updated, ${response.receipt.keptCount} kept, ${response.receipt.skippedCount} skipped.`);
      this.log('The source file was not modified or deleted. Imported values are available only through governed Vault use and bundle pull.');
    }
    return response.receipt;
  }
}
