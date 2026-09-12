import {constants, open} from 'node:fs/promises';
import path from 'node:path';
import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderContractExport} from '../../../lib/envContractExport.js';
import {loadEnvironmentManifest} from '../../../lib/environmentCommand.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag, type VaultOwnerContext} from '../../../lib/vault-owner-context.js';
import {findCheckoutRoot} from '../../../lib/workspace-context.js';

export interface ContractExportAuditMetadata {
  destinationKind: 'stdout' | 'file';
  encoding: 'utf-8';
}

interface ContractExportAuditResponse {
  receipt: {
    id: string;
    exportKind: 'contract';
    format: 'json' | 'csv';
    memberCount: number;
    outcome: 'completed' | 'failed';
  };
}

export default class EnvExportContract extends BaseCommand {
  static summary = 'Export the environment contract (metadata only, never values)';
  static description = 'Renders schema, names, owner-qualified references, sensitivity, public defaults, and documentation from .sift/environment.yaml as JSON or spreadsheet-safe CSV. The output cannot carry secret values by construction. The export is recorded server-side as a value-free audit receipt.\n\nCSV encoding: UTF-8 without BOM, LF line endings, comma delimiter; every field is double-quoted and formula-triggering leading characters are guarded.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    format: Flags.string({required: true, description: 'Export format: json or csv'}),
    output: Flags.string({description: 'New local output file to create (O_EXCL); prints to stdout when omitted'}),
    'checkout-root': Flags.string({description: 'Checkout containing .sift/environment.yaml'}),
  };

  async run(): Promise<{memberCount: number; exportId: string | null; output: string | null}> {
    const {flags} = await this.parse(EnvExportContract);
    if (flags.format !== 'json' && flags.format !== 'csv') {
      this.error('--format must be json or csv.');
    }
    const checkoutRoot = flags['checkout-root']
      ? path.resolve(flags['checkout-root'])
      : findCheckoutRoot() ?? process.cwd();
    const manifest = await loadEnvironmentManifest(checkoutRoot);
    const {rendered, memberCount} = renderContractExport(manifest, flags.format);
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    let outputPath: string | null = null;
    // Fixed value-free audit metadata: the server accepts only these enum
    // members, so no free-form scalar can reach the audit-read boundary.
    const metadata: ContractExportAuditMetadata = {
      destinationKind: flags.output ? 'file' : 'stdout',
      encoding: 'utf-8',
    };
    if (flags.output) {
      outputPath = path.resolve(flags.output);
      try {
        const handle = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(rendered, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        try {
          await this.recordAudit(flags, owner, flags.format, memberCount, 'failed', metadata);
        } catch (auditError) {
          this.warn(`Failed to record the failed-export receipt: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
        }
        throw error;
      }
    }
    const receipt = await this.recordAudit(flags, owner, flags.format, memberCount, 'completed', metadata);
    if (!this.jsonEnabled()) {
      if (!flags.output) this.log(rendered.trimEnd());
      else this.log(`Wrote contract export (${memberCount} members) → ${outputPath}`);
    }
    return {memberCount, exportId: receipt.id, output: outputPath};
  }

  private async recordAudit(
    flags: {token?: string; 'api-url'?: string},
    owner: VaultOwnerContext,
    format: 'json' | 'csv',
    memberCount: number,
    outcome: 'completed' | 'failed',
    metadata: ContractExportAuditMetadata,
  ): Promise<ContractExportAuditResponse['receipt']> {
    const response = await this.apiRequest<ContractExportAuditResponse>(
      vaultApiFlags(flags, owner),
      '/api/v1/vault/exports',
      {
        method: 'POST',
        idempotencyKey: this.idempotencyKey(),
        body: {exportKind: 'contract', format, memberCount, outcome, metadata},
      },
    );
    return response.receipt;
  }
}
