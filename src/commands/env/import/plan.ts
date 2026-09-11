import {Flags} from '@oclif/core';
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
  resolveDotenvImportCheckoutRoot,
  writeDotenvImportPlanArtifact,
  type DotenvImportPlanArtifact,
} from '../../../lib/dotenvImportPlan.js';
import type {DotenvImportDecision, DotenvImportPlanResponse} from '../../../lib/dotenvImportTypes.js';
import {canonicalJson, CsvMappingRequiredError, formatMappingSuggestions, MAX_CSV_IMPORT_BYTES, parseCsvImport, type CsvFieldMapping, valueFreeCsvEntries} from '../../../lib/csvImport.js';
import {
  readExplicitImportSource,
  writeImportPlanArtifact,
  type CsvImportPlanArtifact,
} from '../../../lib/envImportArtifacts.js';
import type {CsvImportPlanResponse} from '../../../lib/csvImportTypes.js';
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

const CSV_MAP_FIELDS = new Set(['name', 'value', 'owner', 'description', 'tags']);

function parseColumnMap(raw: string): [keyof CsvFieldMapping, string] {
  const separator = raw.indexOf('=');
  const field = separator < 0 ? raw : raw.slice(0, separator);
  const header = separator < 0 ? '' : raw.slice(separator + 1);
  if (!CSV_MAP_FIELDS.has(field) || header === '') {
    throw new Error('--map must be field=DisplayedHeader with field one of name, value, owner, description, tags.');
  }
  return [field as keyof CsvFieldMapping, header];
}

export default class EnvImportPlan extends BaseCommand {
  static summary = 'Create a value-free, owner-scoped plan for one explicitly named dotenv or CSV source';
  static description = 'Parses locally with the sift-dotenv-v1 or sift-csv-v1 dialect. Values are not sent during planning. Existing entries default to keep-existing; duplicate source names default to skip. CSV requires an explicit header mapping; suggestions are displayed but never applied automatically.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    source: Flags.string({required: true, description: 'Explicit dotenv or CSV source file'}),
    format: Flags.string({default: 'dotenv', description: 'Source format: dotenv or csv'}),
    'header-row': Flags.integer({description: 'CSV header row (1-based line number)'}),
    delimiter: Flags.string({description: 'CSV delimiter: comma, semicolon, tab, or pipe'}),
    map: Flags.string({
      multiple: true,
      description: 'CSV column mapping: field=DisplayedHeader (repeatable)',
    }),
    'plan-file': Flags.string({required: true, description: 'New local value-free plan artifact to create'}),
    'checkout-root': Flags.string({description: 'Checkout used only to reject Sift-managed source files'}),
    project: Flags.string({description: 'Exact owner-scoped project UUID'}),
    decision: Flags.string({
      multiple: true,
      description: 'Explicit per-index decision: INDEX:keep-existing|overwrite|skip|rename=NAME',
    }),
  };

  async run(): Promise<DotenvImportPlanArtifact | CsvImportPlanArtifact> {
    const {flags} = await this.parse(EnvImportPlan);
    if (flags.format === 'csv') {
      return this.runCsv(flags);
    }
    if (flags.format !== 'dotenv') {
      this.error('--format must be dotenv or csv.');
    }
    const source = await readExplicitDotenvSource(flags.source);
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(source.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(source, checkoutRoot);
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
      applyIdempotencyKey: this.idempotencyKey(),
      plan: response.plan,
    };
    await writeDotenvImportPlanArtifact(flags['plan-file'], artifact);
    if (!this.jsonEnabled()) {
      this.log(`Plan ${response.plan.id} (${response.plan.items.length} entries) → ${path.resolve(flags['plan-file'])}`);
      for (const item of response.plan.items) {
        this.log(`${item.sourceIndex}\t${item.key}\t${item.conflictClass}\t${item.existingEntryType ?? '-'}\t${item.proposedAction}\t${item.targetSlug}`);
      }
      this.log(`Apply only after review: sift env import apply --source ${JSON.stringify(flags.source)} --plan-file ${JSON.stringify(flags['plan-file'])} --checkout-root ${JSON.stringify(checkoutRoot)} --owner ${JSON.stringify(owner.owner)}`);
    }
    return artifact;
  }

  private async runCsv(flags: {
    source: string; 'plan-file': string; 'checkout-root'?: string; project?: string;
    owner?: string; workspace?: string; 'header-row'?: number; delimiter?: string;
    map?: string[]; decision?: string[]; token?: string; 'api-url'?: string;
  }): Promise<CsvImportPlanArtifact> {
    if (flags['header-row'] === undefined) {
      this.error('--header-row is required with --format csv (1-based line number of the header row).');
    }
    const headerRow = flags['header-row'];
    const delimiterByName: Record<string, string> = {comma: ',', semicolon: ';', tab: '\t', pipe: '|'};
    const delimiter = flags.delimiter === undefined
      ? ','
      : (delimiterByName[flags.delimiter] ?? flags.delimiter);
    const source = await readExplicitImportSource(flags.source, MAX_CSV_IMPORT_BYTES, 'CSV');
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(source.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(source, checkoutRoot);
    const mapping: CsvFieldMapping = {name: '', value: ''};
    for (const raw of flags.map ?? []) {
      const [field, header] = parseColumnMap(raw);
      if (mapping[field] !== undefined && mapping[field] !== '') {
        this.error(`Duplicate --map for field ${JSON.stringify(field)}.`);
      }
      mapping[field] = header;
    }
    let parsed;
    try {
      parsed = parseCsvImport(source.raw, {
        filename: source.path,
        delimiter,
        headerRow,
        mapping: mapping.name && mapping.value ? mapping : undefined,
      });
    } catch (error) {
      if (error instanceof CsvMappingRequiredError) {
        this.error(formatMappingSuggestions(error.headers, error.headerRowNumber, error.delimiter));
      }
      throw error;
    }
    const sourceBinding = createDotenvSourceBinding(source.raw);
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    const profile = {
      headerRowNumber: parsed.headerRowNumber,
      delimiter: parsed.delimiter,
      columnCount: parsed.columnCount,
      dataRowCount: parsed.entries.length,
      mapping: {
        nameColumn: {index: parsed.headers.indexOf(mapping.name), header: mapping.name},
        valueColumn: {index: parsed.headers.indexOf(mapping.value), header: mapping.value},
        ...(mapping.owner ? {ownerColumn: {index: parsed.headers.indexOf(mapping.owner), header: mapping.owner}} : {}),
        ...(mapping.description
          ? {descriptionColumn: {index: parsed.headers.indexOf(mapping.description), header: mapping.description}}
          : {}),
        ...(mapping.tags ? {tagsColumn: {index: parsed.headers.indexOf(mapping.tags), header: mapping.tags}} : {}),
      },
    };
    const response = await this.apiRequest<CsvImportPlanResponse>(
      vaultApiFlags(flags, owner),
      '/api/v1/vault/import-plans',
      {
        method: 'POST',
        body: {
          dialect: parsed.dialect,
          ...sourceBinding,
          ...(flags.project ? {projectId: flags.project} : {}),
          sourceProfile: profile,
          entries: valueFreeCsvEntries(parsed.entries),
          decisions: (flags.decision ?? []).map(parseDecision),
        },
      },
    );
    if (response.plan.ownerType !== owner.kind
      || (owner.kind === 'workspace' && response.plan.ownerId !== owner.workspaceId)
      || response.plan.sourceNonce !== sourceBinding.sourceNonce
      || response.plan.sourceDigest !== sourceBinding.sourceDigest
      || response.plan.dialect !== parsed.dialect
      || response.plan.projectId !== (flags.project ?? null)
      || canonicalJson(response.plan.sourceProfile) !== canonicalJson(profile)) {
      this.error('Server CSV import plan does not match the explicit local owner, source binding, and profile.');
    }
    const artifact: CsvImportPlanArtifact = {
      schemaVersion: 1,
      kind: 'sift.vault.csv-import-plan',
      applyIdempotencyKey: this.idempotencyKey(),
      plan: response.plan,
    };
    await writeImportPlanArtifact(flags['plan-file'], artifact);
    if (!this.jsonEnabled()) {
      this.log(`Plan ${response.plan.id} (${response.plan.items.length} entries) → ${path.resolve(flags['plan-file'])}`);
      for (const item of response.plan.items) {
        this.log(`${item.sourceIndex}\trow ${item.rowNumber}\t${item.key}\t${item.rowClass}\t${item.conflictClass}\t${item.proposedAction}\t${item.targetSlug}`);
      }
      if (parsed.injectionWarnings.length > 0) {
        this.log(`Warning: ${parsed.injectionWarnings.length} spreadsheet-formula-shaped cells detected (row/column only, content withheld):`);
        for (const warning of parsed.injectionWarnings.slice(0, 20)) {
          this.log(`row ${warning.rowNumber}, column ${warning.columnNumber}`);
        }
      }
      this.log(`Apply only after review: sift env import apply --format csv --source ${JSON.stringify(flags.source)} --plan-file ${JSON.stringify(flags['plan-file'])} --checkout-root ${JSON.stringify(checkoutRoot)} --owner ${JSON.stringify(owner.owner)}`);
    }
    return artifact;
  }
}
