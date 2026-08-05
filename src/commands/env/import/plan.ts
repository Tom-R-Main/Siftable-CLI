import {Flags} from '@oclif/core';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  createDotenvSourceBinding,
  parseDotenvImport,
  valueFreeDotenvEntries,
} from '../../../lib/dotenvImport.js';
import {
  assertDotenvSourceIsNotManaged,
  readExplicitDotenvSource,
  writeDotenvImportPlanArtifact,
  type DotenvImportPlanArtifact,
} from '../../../lib/dotenvImportPlan.js';
import type {DotenvImportDecision, DotenvImportPlanResponse} from '../../../lib/dotenvImportTypes.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

function parseDecision(raw: string): DotenvImportDecision {
  const matched = /^(\d+):(keep-existing|overwrite|skip|rename=([A-Za-z_][A-Za-z0-9_]{0,127}))$/.exec(raw);
  if (!matched) {
    throw new Error('--decision must be INDEX:keep-existing, INDEX:overwrite, INDEX:skip, or INDEX:rename=NAME.');
  }
  const sourceIndex = Number.parseInt(matched[1]!, 10);
  if (matched[2]!.startsWith('rename=')) {
    return {sourceIndex, action: 'rename', renameTo: matched[3]!};
  }
  return {
    sourceIndex,
    action: matched[2] === 'keep-existing' ? 'keep_existing' : matched[2] as 'overwrite' | 'skip',
  };
}

export default class EnvImportPlan extends BaseCommand {
  static summary = 'Create a value-free, owner-scoped plan for one explicitly named dotenv source';
  static description = 'Parses locally with the sift-dotenv-v1 dialect. Values are not sent during planning. Existing entries default to keep-existing; duplicate source names default to skip.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    source: Flags.string({required: true, description: 'Explicit dotenv source file'}),
    'plan-file': Flags.string({required: true, description: 'New local value-free plan artifact to create'}),
    'checkout-root': Flags.string({description: 'Checkout used only to reject Sift-managed source files'}),
    project: Flags.string({description: 'Exact owner-scoped project UUID'}),
    decision: Flags.string({
      multiple: true,
      description: 'Explicit per-index decision: INDEX:keep-existing|overwrite|skip|rename=NAME',
    }),
  };

  async run(): Promise<DotenvImportPlanArtifact> {
    const {flags} = await this.parse(EnvImportPlan);
    const checkoutRoot = await realpath(path.resolve(flags['checkout-root'] ?? process.cwd()));
    const source = await readExplicitDotenvSource(flags.source);
    await assertDotenvSourceIsNotManaged(source.path, checkoutRoot);
    const parsed = parseDotenvImport(source.raw);
    const sourceBinding = createDotenvSourceBinding(source.raw);
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    const response = await this.apiRequest<DotenvImportPlanResponse>(
      vaultApiFlags(flags, owner),
      '/api/v1/vault/import-plans',
      {
        method: 'POST',
        body: {
          dialect: parsed.dialect,
          ...sourceBinding,
          ...(flags.project ? {projectId: flags.project} : {}),
          entries: valueFreeDotenvEntries(parsed.entries),
          decisions: (flags.decision ?? []).map(parseDecision),
        },
      },
    );
    const expectedOwnerType = owner.kind;
    if (response.plan.ownerType !== expectedOwnerType
      || (owner.kind === 'workspace' && response.plan.ownerId !== owner.workspaceId)
      || response.plan.sourceNonce !== sourceBinding.sourceNonce
      || response.plan.sourceDigest !== sourceBinding.sourceDigest
      || response.plan.dialect !== parsed.dialect
      || response.plan.projectId !== (flags.project ?? null)) {
      this.error('Server dotenv import plan does not match the explicit local owner and source binding.');
    }
    const artifact: DotenvImportPlanArtifact = {
      schemaVersion: 1,
      kind: 'sift.vault.dotenv-import-plan',
      plan: response.plan,
    };
    await writeDotenvImportPlanArtifact(flags['plan-file'], artifact);
    if (!this.jsonEnabled()) {
      this.log(`Plan ${response.plan.id} (${response.plan.items.length} entries) → ${path.resolve(flags['plan-file'])}`);
      for (const item of response.plan.items) {
        this.log(`${item.sourceIndex}\t${item.key}\t${item.conflictClass}\t${item.proposedAction}\t${item.targetSlug}`);
      }
      this.log(`Apply only after review: sift env import apply --source ${JSON.stringify(flags.source)} --plan-file ${JSON.stringify(flags['plan-file'])}`);
    }
    return artifact;
  }
}
