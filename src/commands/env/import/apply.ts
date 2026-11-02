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
import {
  MAX_CSV_IMPORT_BYTES,
  parseCsvImport,
  type CsvFieldMapping,
} from '../../../lib/csvImport.js';
import {
  readCsvImportPlanArtifact,
  readExplicitImportSource,
  writeImportReceiptArtifact,
  type CsvImportPlanArtifact,
} from '../../../lib/envImportArtifacts.js';
import type {CsvImportApplyResponse, ImportReceiptArtifact as ReceiptArtifact} from '../../../lib/csvImportTypes.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class EnvImportApply extends BaseCommand {
  static summary = 'Apply one exact reviewed dotenv or CSV import plan atomically';
  static description = 'Re-reads and re-parses the explicitly named source, rejects any source or plan drift, and sends values only to the transactional apply endpoint.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    source: Flags.string({required: true, description: 'Same explicit source used to create the plan'}),
    format: Flags.string({default: 'dotenv', description: 'Source format: dotenv or csv'}),
    'plan-file': Flags.string({required: true, description: 'Reviewed value-free plan artifact'}),
    'checkout-root': Flags.string({description: 'Checkout used only to reject Sift-managed source files'}),
    'receipt-file': Flags.string({description: 'New local value-free import receipt to create (required for later source cleanup)'}),
  };

  async run(): Promise<DotenvImportApplyResponse['receipt'] | CsvImportApplyResponse['receipt']> {
    const {flags} = await this.parse(EnvImportApply);
    if (flags.format === 'csv') {
      return this.runCsv(flags);
    }
    if (flags.format !== 'dotenv') {
      this.error('--format must be dotenv or csv.');
    }
    const source = await readExplicitDotenvSource(flags.source);
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(source.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(source, checkoutRoot);
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
        idempotencyKey: artifact.applyIdempotencyKey,
        body: {
          planDigest: artifact.plan.planDigest,
          sourceNonce: artifact.plan.sourceNonce,
          sourceDigest: rebound.sourceDigest,
          entries: parsed.entries.map(({sourceIndex, key, value}) => {
            const action = plannedByIndex.get(sourceIndex)!.proposedAction;
            const writesValue = action === 'create' || action === 'rename' || action === 'overwrite';
            return {sourceIndex, key, valuePresent: writesValue, value: writesValue ? value : ''};
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
    if (flags['receipt-file']) {
      await this.writeReceipt(flags['receipt-file'], {
        dialect: 'sift-dotenv-v1',
        sourcePath: source.path,
        sourceBinding: rebound,
        planId: artifact.plan.id,
        planDigest: artifact.plan.planDigest,
        receipt: response.receipt,
      });
    }
    if (!this.jsonEnabled()) {
      this.log(`Applied ${response.receipt.importId}: ${response.receipt.createdCount} created, ${response.receipt.updatedCount} updated, ${response.receipt.keptCount} kept, ${response.receipt.skippedCount} skipped.`);
      this.log('The source file was not modified or deleted. Imported values are available only through governed Vault use and bundle pull.');
    }
    return response.receipt;
  }

  private async writeReceipt(
    filename: string,
    input: {
      dialect: 'sift-dotenv-v1' | 'sift-csv-v1';
      sourcePath: string;
      sourceBinding: {sourceNonce: string; sourceDigest: string};
      planId: string;
      planDigest: string;
      receipt: {
        importId: string; ownerType: 'user' | 'workspace'; ownerId: string; projectId: string | null;
        createdCount: number; updatedCount: number; keptCount: number; skippedCount: number;
      };
    },
  ): Promise<ReceiptArtifact> {
    const artifact: ReceiptArtifact = {
      schemaVersion: 1,
      kind: 'sift.vault.import-receipt',
      dialect: input.dialect,
      sourcePath: input.sourcePath,
      sourceNonce: input.sourceBinding.sourceNonce,
      sourceDigest: input.sourceBinding.sourceDigest,
      planId: input.planId,
      planDigest: input.planDigest,
      importId: input.receipt.importId,
      ownerType: input.receipt.ownerType,
      ownerId: input.receipt.ownerId,
      projectId: input.receipt.projectId,
      counts: {
        created: input.receipt.createdCount,
        updated: input.receipt.updatedCount,
        kept: input.receipt.keptCount,
        skipped: input.receipt.skippedCount,
      },
      completedAt: new Date().toISOString(),
    };
    await writeImportReceiptArtifact(filename, artifact);
    return artifact;
  }

  private async runCsv(flags: {
    source: string; 'plan-file': string; 'checkout-root'?: string;
    owner?: string; workspace?: string; token?: string; 'api-url'?: string;
    'receipt-file'?: string;
  }): Promise<CsvImportApplyResponse['receipt']> {
    const artifact: CsvImportPlanArtifact = await readCsvImportPlanArtifact(flags['plan-file']);
    const profile = artifact.plan.sourceProfile;
    const mapping: CsvFieldMapping = {
      name: profile.mapping.nameColumn.header,
      value: profile.mapping.valueColumn.header,
      ...(profile.mapping.ownerColumn ? {owner: profile.mapping.ownerColumn.header} : {}),
      ...(profile.mapping.descriptionColumn ? {description: profile.mapping.descriptionColumn.header} : {}),
      ...(profile.mapping.tagsColumn ? {tags: profile.mapping.tagsColumn.header} : {}),
    };
    const source = await readExplicitImportSource(flags.source, MAX_CSV_IMPORT_BYTES, 'CSV');
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(source.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(source, checkoutRoot);
    const parsed = parseCsvImport(source.raw, {
      filename: source.path,
      delimiter: profile.delimiter,
      headerRow: profile.headerRowNumber,
      mapping,
    });
    const rebound = createDotenvSourceBinding(source.raw, artifact.plan.sourceNonce);
    if (rebound.sourceDigest !== artifact.plan.sourceDigest) {
      this.error('CSV source changed after planning. Create and review a new plan.');
    }
    const plannedByIndex = new Map(artifact.plan.items.map((item) => [item.sourceIndex, item]));
    if (parsed.entries.length !== artifact.plan.items.length || parsed.entries.some((entry) => {
      const planned = plannedByIndex.get(entry.sourceIndex);
      return !planned || planned.key !== entry.key || planned.rowNumber !== entry.rowNumber
        || planned.duplicateClass !== entry.duplicateClass || planned.rowClass !== entry.rowClass;
    })) {
      this.error('CSV source structure changed after planning. Create and review a new plan.');
    }
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    if (artifact.plan.ownerType !== owner.kind
      || (owner.kind === 'workspace' && artifact.plan.ownerId !== owner.workspaceId)) {
      this.error('Selected Vault owner does not match the reviewed import plan.');
    }
    const response = await this.apiRequest<CsvImportApplyResponse>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/import-plans/${encodeURIComponent(artifact.plan.id)}/apply`,
      {
        method: 'POST',
        idempotencyKey: artifact.applyIdempotencyKey,
        body: {
          planDigest: artifact.plan.planDigest,
          sourceNonce: artifact.plan.sourceNonce,
          sourceDigest: rebound.sourceDigest,
          entries: parsed.entries.map(({sourceIndex, key, value}) => {
            const action = plannedByIndex.get(sourceIndex)!.proposedAction;
            const writesValue = action === 'create' || action === 'rename' || action === 'overwrite';
            return {sourceIndex, key, valuePresent: writesValue, value: writesValue ? value : ''};
          }),
        },
      },
    );
    if (response.receipt.planId !== artifact.plan.id
      || response.receipt.planDigest !== artifact.plan.planDigest
      || response.receipt.ownerType !== artifact.plan.ownerType
      || response.receipt.ownerId !== artifact.plan.ownerId
      || response.receipt.projectId !== artifact.plan.projectId) {
      this.error('Server CSV import receipt does not match the reviewed plan binding.');
    }
    if (flags['receipt-file']) {
      await this.writeReceipt(flags['receipt-file'], {
        dialect: 'sift-csv-v1',
        sourcePath: source.path,
        sourceBinding: rebound,
        planId: artifact.plan.id,
        planDigest: artifact.plan.planDigest,
        receipt: response.receipt,
      });
    }
    if (!this.jsonEnabled()) {
      this.log(`Applied ${response.receipt.importId}: ${response.receipt.createdCount} created, ${response.receipt.updatedCount} updated, ${response.receipt.keptCount} kept, ${response.receipt.skippedCount} skipped.`);
      this.log('The source file was not modified or deleted. To remove the reviewed source afterwards, use: sift env import cleanup --source <file> --receipt-file <receipt> --yes.');
    }
    return response.receipt;
  }
}
