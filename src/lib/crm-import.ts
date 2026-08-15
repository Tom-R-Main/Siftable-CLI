import {parseTabularBytes, type TabularParseResult} from '@siftable/tabular-import/node';
import {basename, extname, resolve} from 'node:path';
import {readFileSync, statSync} from 'node:fs';
import {renderDetail, renderTable} from './output.js';

export const CRM_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxSheets: 32,
  maxColumnsPerSheet: 1_000,
  maxRows: 25_000,
});

export const CRM_IMPORT_SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.xls', '.xlsx'] as const;

type CliInputError = Error & {code?: string; suggestions?: string[]};

function inputError(message: string, code: string, suggestions: string[]): CliInputError {
  return Object.assign(new Error(message), {code, suggestions});
}

export function assertCrmImportSourceWithinLimits(source: TabularParseResult): void {
  if (source.sheets.length > CRM_IMPORT_LIMITS.maxSheets) {
    throw inputError(
      `CRM import supports at most ${CRM_IMPORT_LIMITS.maxSheets} sheets; received ${source.sheets.length}.`,
      'crm_import_sheet_limit_exceeded',
      ['Split the workbook and create a separate durable plan for each file.'],
    );
  }
  const totalRows = source.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  if (totalRows > CRM_IMPORT_LIMITS.maxRows) {
    throw inputError(
      `CRM import input exceeds the ${CRM_IMPORT_LIMITS.maxRows.toLocaleString('en-US')}-row planning limit across all sheets (${totalRows.toLocaleString('en-US')} rows).`,
      'crm_import_tabular_limit_exceeded',
      ['Split the source so each plan contains at most 25,000 rows across all sheets.'],
    );
  }
  if (source.truncated) {
    throw inputError(
      'CRM import input exceeds the 25,000-row or 1,000-column planning limit.',
      'crm_import_tabular_limit_exceeded',
      ['Split the source so every plan is within 25,000 rows across all sheets, 1,000 columns per sheet, and 32 sheets.'],
    );
  }
  if (source.errors.length > 0) {
    throw inputError(
      `CRM import parsing failed: ${source.errors.map(error => error.message).join('; ')}`,
      'crm_import_parse_failed',
      ['Correct the source diagnostics and rerun the plan command; no canonical CRM records were written.'],
    );
  }
}

export function parseCrmImportFile(filePath: string): TabularParseResult {
  const absolutePath = resolve(filePath);
  const extension = extname(absolutePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    throw inputError(
      'HTML is not a supported CRM import format.',
      'crm_import_unsupported_html',
      [
        'Export or normalize the table to CSV or XLSX, then rerun `sift crm import plan <file>`.',
        'Keep stable source identifiers in the normalized file so duplicate review and provenance remain deterministic.',
      ],
    );
  }
  if (!CRM_IMPORT_SUPPORTED_EXTENSIONS.includes(extension as typeof CRM_IMPORT_SUPPORTED_EXTENSIONS[number])) {
    throw inputError(
      `Unsupported CRM import format: ${extension || '(no extension)'}.`,
      'crm_import_unsupported_format',
      ['Use CSV, TSV, XLS, or XLSX. HTML must first be normalized to CSV or XLSX.'],
    );
  }

  let size: number;
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    throw inputError(
      `CRM import file not found: ${filePath}`,
      'crm_import_file_not_found',
      ['Check the path and retry with a readable CSV, TSV, XLS, or XLSX file.'],
    );
  }
  if (size > CRM_IMPORT_LIMITS.maxFileBytes) {
    throw inputError(
      `CRM import file exceeds the 8 MiB limit (${size} bytes).`,
      'crm_import_file_too_large',
      ['Split the source into files no larger than 8 MiB and create a separate durable plan for each file.'],
    );
  }

  const source = parseTabularBytes(readFileSync(absolutePath), {
    filename: basename(absolutePath),
    maxSheets: CRM_IMPORT_LIMITS.maxSheets,
    maxRows: CRM_IMPORT_LIMITS.maxRows,
    maxColumns: CRM_IMPORT_LIMITS.maxColumnsPerSheet,
  });
  assertCrmImportSourceWithinLimits(source);
  return source;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
    : [];
}

export function renderCrmImportPlan(planValue: unknown, reused?: boolean): void {
  const plan = record(planValue);
  const owner = record(plan.owner);
  const summary = record(plan.summary);
  const operations = records(plan.operations);
  renderDetail([
    ['Plan', plan.id ?? 'unknown'],
    ['Run', plan.runId ?? 'unknown'],
    ['Owner', `${owner.type ?? 'unknown'}:${owner.id ?? 'unknown'}`],
    ['Status', plan.status ?? 'unknown'],
    ['Version', plan.version ?? 'unknown'],
    ['Input hash', plan.inputHash ?? 'unknown'],
    ...(reused === undefined ? [] : [['Reused', reused ? 'yes' : 'no'] as [string, unknown]]),
    ['Operations', summary.total ?? operations.length],
    ['Duplicates', summary.duplicates ?? 0],
    ['Review required', summary.reviewRequired ?? 0],
  ]);

  const visibleOperations = operations.slice(0, 50);
  if (visibleOperations.length > 0) {
    console.log('');
    renderTable(visibleOperations, [
      {key: 'id', header: 'Record ID'},
      {key: 'operationId', header: 'Operation ID', get: row => String(record(row.operation).operationId ?? '—')},
      {key: 'type', header: 'Type', get: row => String(record(row.operation).type ?? '—')},
      {key: 'decision', header: 'Decision'},
      {key: 'applyStatus', header: 'Apply'},
    ]);
    if (operations.length > visibleOperations.length) {
      console.log(`Showing 50 of ${operations.length} operations. Use --json to inspect the complete durable plan.`);
    }
  }
}
