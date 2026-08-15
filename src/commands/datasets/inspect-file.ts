import {Args, Flags} from '@oclif/core';
import {
  inspectTabularFile,
  TabularInspectError,
  type TabularFormat,
  type TabularParseResult,
  type TabularSheet,
} from '@siftable/tabular-import/node';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

const FORMATS: TabularFormat[] = ['csv', 'tsv', 'xls', 'xlsx'];

/**
 * Read-only structural inspection of a local delimited or workbook file.
 *
 * Deliberately omits BaseCommand.baseFlags: this command never authenticates,
 * never calls the API, and never mutates a dataset, so token/api-url/workspace
 * flags would advertise a capability it does not have.
 */
export default class DatasetsInspectFile extends BaseCommand {
  static description = 'Inspect the structure of a local CSV, TSV, XLS, or XLSX file without creating or changing a dataset';

  static examples = [
    '<%= config.bin %> <%= command.id %> ./accounts.xlsx',
    '<%= config.bin %> <%= command.id %> ./accounts.xlsx --sheet Accounts --json',
  ];

  static args = {
    file: Args.string({description: 'Path to a local CSV, TSV, XLS, or XLSX file', required: true}),
  };

  static flags = {
    sheet: Flags.string({description: 'Inspect only this sheet; the full sheet inventory is still reported'}),
    'header-row': Flags.integer({description: 'Zero-based header row index within the sheet grid'}),
    'max-rows': Flags.integer({description: 'Maximum data rows returned per sheet'}),
    'max-cols': Flags.integer({description: 'Maximum columns returned per sheet'}),
    'max-sheets': Flags.integer({description: 'Maximum sheets returned'}),
    'max-bytes': Flags.integer({description: 'Refuse files larger than this many bytes'}),
    delimiter: Flags.string({description: 'Single-byte delimiter override for CSV/TSV'}),
    format: Flags.string({description: 'Format override when the extension is absent or wrong', options: FORMATS}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsInspectFile);

    let inspection: TabularParseResult;
    try {
      inspection = inspectTabularFile(args.file, {
        ...(flags.sheet === undefined ? {} : {sheet: flags.sheet}),
        ...(flags['header-row'] === undefined ? {} : {headerRow: flags['header-row']}),
        ...(flags['max-rows'] === undefined ? {} : {maxRows: flags['max-rows']}),
        ...(flags['max-cols'] === undefined ? {} : {maxColumns: flags['max-cols']}),
        ...(flags['max-sheets'] === undefined ? {} : {maxSheets: flags['max-sheets']}),
        ...(flags['max-bytes'] === undefined ? {} : {maxBytes: flags['max-bytes']}),
        ...(flags.delimiter === undefined ? {} : {delimiter: flags.delimiter}),
        ...(flags.format === undefined ? {} : {format: flags.format as TabularFormat}),
      });
    } catch (error) {
      if (error instanceof TabularInspectError) {
        this.error(error.message);
      }
      throw error;
    }

    const failed = inspection.errors.length > 0;

    if (this.jsonEnabled()) {
      // Emit the envelope either way so machine callers always see the
      // diagnostics that explain a failure, and signal failure via exit code.
      if (failed) process.exitCode = 1;
      return {ok: !failed, inspection};
    }

    renderInspection(inspection);
    if (failed) {
      this.error(inspection.errors[0]?.message ?? 'Failed to inspect file.');
    }
    return {ok: true, inspection};
  }
}

function renderInspection(inspection: TabularParseResult): void {
  const sheetTruncation = inspection.sheetTruncation;
  renderDetail([
    ['File', inspection.filename],
    ['Hash', inspection.fileHash],
    ['Format', inspection.format ?? 'unrecognized'],
    ['Delimiter', inspection.delimiter === null ? '—' : describeDelimiter(inspection.delimiter)],
    ['Engine', inspection.engine ?? '—'],
    ['Fallback', inspection.fallbackReason ?? '—'],
    ['Sheets', sheetTruncation ? `${sheetTruncation.returned} of ${sheetTruncation.total}` : inspection.sheets.length],
    ['Inventory', (inspection.sheetInventory ?? []).join(', ') || '—'],
    ['Truncated', inspection.truncated],
  ]);

  for (const sheet of inspection.sheets) {
    console.log('');
    renderSheet(sheet);
  }

  const diagnostics = [
    ...inspection.errors.map((diagnostic) => ({severity: 'error', ...diagnostic})),
    ...inspection.warnings.map((diagnostic) => ({severity: 'warning', ...diagnostic})),
  ];
  if (diagnostics.length > 0) {
    console.log('');
    console.log('Diagnostics');
    renderTable(diagnostics as unknown as Record<string, unknown>[], [
      {key: 'severity', header: 'Severity'},
      {key: 'code', header: 'Code'},
      {key: 'sheetName', header: 'Sheet'},
      {key: 'sourceRowNumber', header: 'Row'},
      {key: 'sourceColumnNumber', header: 'Col'},
      {key: 'message', header: 'Message'},
    ]);
  }
}

function renderSheet(sheet: TabularSheet): void {
  const range = sheet.sourceRange;
  console.log(`Sheet: ${sheet.name}`);
  renderDetail([
    ['Header row', sheet.headerSourceRowNumber ?? sheet.headerRow],
    ['Rows', `${sheet.truncation.rows.returned} of ${sheet.truncation.rows.total}`],
    ['Columns', `${sheet.truncation.columns.returned} of ${sheet.truncation.columns.total}`],
    ['Source range', range ? `rows ${range.firstRow}-${range.lastRow}, columns ${range.firstColumn}-${range.lastColumn}` : '—'],
    ['Source columns', (sheet.sourceColumnNumbers ?? []).join(', ') || '—'],
    ['Headers', sheet.headers.join(', ') || '—'],
  ]);

  // Formula text is untrusted file content; renderTable sanitizes terminal control
  // sequences. Formulas are reported, never evaluated.
  const formulas = sheet.rows.flatMap((row) =>
    (row.formulaCells ?? []).map((cell) => ({
      row: row.sourceRowNumber,
      column: cell.sourceColumnNumber,
      risks: (cell.risks ?? []).join(', ') || '—',
      cached: cell.cachedValueMissing ? 'missing' : 'present',
      formula: cell.formula,
    })),
  );
  if (formulas.length > 0) {
    console.log('');
    console.log(`Formula cells: ${formulas.length}`);
    renderTable(formulas as unknown as Record<string, unknown>[], [
      {key: 'row', header: 'Row'},
      {key: 'column', header: 'Col'},
      {key: 'risks', header: 'Risks'},
      {key: 'cached', header: 'Cached'},
      {key: 'formula', header: 'Formula'},
    ]);
  }
}

function describeDelimiter(delimiter: string): string {
  if (delimiter === '\t') return '\\t';
  return delimiter;
}
