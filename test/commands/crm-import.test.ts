import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import CrmImportApply from '../../src/commands/crm/import/apply.js';
import CrmImportApprove from '../../src/commands/crm/import/approve.js';
import {
  CRM_IMPORT_LIMITS,
  CRM_IMPORT_SUPPORTED_EXTENSIONS,
  assertCrmImportSourceWithinLimits,
  parseCrmImportFile,
  renderCrmImportPlan,
} from '../../src/lib/crm-import.js';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

const tempDir = mkdtempSync(join(tmpdir(), 'sift-crm-import-'));
const csvPath = join(tempDir, 'contacts.csv');
const htmlPath = join(tempDir, 'contacts.html');
const planId = '11111111-1111-4111-8111-111111111111';
const operationId = 'person.create:sha256:source:Sheet1:2';

const plan = {
  id: planId,
  runId: '22222222-2222-4222-8222-222222222222',
  owner: {type: 'user', id: '33333333-3333-4333-8333-333333333333'},
  version: 1,
  inputHash: `sha256:${'b'.repeat(64)}`,
  status: 'planned',
  baseVersions: {},
  validationResults: {},
  summary: {total: 1, created: 1, updated: 0, skipped: 0, duplicates: 0, flagged: 0},
  operations: [{
    id: '44444444-4444-4444-8444-444444444444',
    operation: {type: 'person.create', operationId, provenance: {fileHash: `sha256:${'a'.repeat(64)}`}},
    decision: 'pending',
    applyStatus: 'pending',
    validationResult: {},
    applyResult: null,
  }],
  applyResult: null,
};

beforeAll(() => {
  writeFileSync(csvPath, 'Name,Email\nAda Lovelace,ada@example.test\n');
  writeFileSync(htmlPath, '<table><tr><td>Ada</td></tr></table>');
});

afterAll(() => {
  restoreFetch();
  rmSync(tempDir, {recursive: true, force: true});
});

describe('CRM import CLI parity', () => {
  test('plan parses with the shared tabular engine and preserves the exact durable response', async () => {
    let capturedSource: Record<string, any> | undefined;
    mockFetch()
      .on('POST', '/api/v1/imports/crm/plans')
      .body((body) => {
        const payload = body as Record<string, any>;
        capturedSource = payload.source;
        return payload.provider === 'generic'
          && payload.mappingMode === 'manual'
          && payload.source.filename === 'contacts.csv';
      })
      .reply(201, {plan, reused: false})
      .install();

    const result = await runCommand([
      'crm', 'import', 'plan', csvPath, '--token', 'exf_pat_test', '--json',
    ]);

    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({plan, reused: false});
    expect(capturedSource).toEqual(expect.objectContaining({
      filename: 'contacts.csv',
      fileHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      format: 'csv',
      truncated: false,
    }));
    expect(capturedSource?.sheets[0].rows[0]).toEqual(expect.objectContaining({
      sourceRowNumber: 2,
      originalCells: ['Ada Lovelace', 'ada@example.test'],
      cells: ['Ada Lovelace', 'ada@example.test'],
    }));
  });

  test('get, approve, and apply resume the same plan ID and preserve server identities', async () => {
    const approved = {...plan, version: 2, status: 'approved', operations: plan.operations.map(operation => ({...operation, decision: 'approved'}))};
    const applied = {...approved, version: 3, status: 'applied', operations: approved.operations.map(operation => ({...operation, applyStatus: 'applied', applyResult: {receiptId: 'receipt-1'}}))};
    mockFetch()
      .on('GET', `/api/v1/imports/crm/plans/${planId}`)
      .reply(200, {plan})
      .on('POST', `/api/v1/imports/crm/plans/${planId}/approve`)
      .body(body => JSON.stringify(body) === JSON.stringify({reason: 'Reviewed source', operationIds: [operationId]}))
      .reply(200, {plan: approved})
      .on('POST', `/api/v1/imports/crm/plans/${planId}/apply`)
      .reply(200, {plan: applied})
      .install();

    const get = await runCommand(['crm', 'import', 'get', planId, '--token', 'exf_pat_test', '--json']);
    const approve = await runCommand([
      'crm', 'import', 'approve', planId,
      '--reason', 'Reviewed source', '--operation-id', operationId,
      '--yes', '--token', 'exf_pat_test', '--json',
    ]);
    const apply = await runCommand([
      'crm', 'import', 'apply', planId, '--yes', '--token', 'exf_pat_test', '--json',
    ]);

    expect(JSON.parse(get.stdout)).toEqual({plan});
    expect(JSON.parse(approve.stdout)).toEqual({plan: approved});
    expect(JSON.parse(apply.stdout)).toEqual({plan: applied});
    expect(JSON.parse(apply.stdout).plan.operations[0].operation.operationId).toBe(operationId);
    expect(JSON.parse(apply.stdout).plan.operations[0].applyResult.receiptId).toBe('receipt-1');
  });

  test('rejects HTML locally with actionable recovery and never invents a parser', () => {
    expect(() => parseCrmImportFile(htmlPath)).toThrow(expect.objectContaining({
      code: 'crm_import_unsupported_html',
      suggestions: expect.arrayContaining([expect.stringContaining('CSV or XLSX')]),
    }));
  });

  test('applies the row limit across the entire workbook rather than per sheet', () => {
    const parsed = parseCrmImportFile(csvPath);
    const sheet = parsed.sheets[0]!;
    const row = sheet.rows[0]!;
    const firstRows = Array.from({length: 12_501}, () => row);
    const secondRows = Array.from({length: 12_500}, () => row);

    expect(() => assertCrmImportSourceWithinLimits({
      ...parsed,
      sheets: [
        {...sheet, name: 'First', rows: firstRows},
        {...sheet, name: 'Second', rows: secondRows},
      ],
      truncated: false,
    })).toThrow(expect.objectContaining({
      code: 'crm_import_tabular_limit_exceeded',
      message: expect.stringContaining('across all sheets'),
    }));
  });

  test('documents supported formats, bounds, approval separation, and replay behavior', () => {
    expect(CRM_IMPORT_SUPPORTED_EXTENSIONS).toEqual(['.csv', '.tsv', '.xls', '.xlsx']);
    expect(CRM_IMPORT_LIMITS).toEqual({
      maxFileBytes: 8 * 1024 * 1024,
      maxSheets: 32,
      maxColumnsPerSheet: 1_000,
      maxRows: 25_000,
    });
    expect(CrmImportApprove.flags['operation-id']).toEqual(expect.objectContaining({multiple: true}));
    expect(CrmImportApply.description).toContain('only approved');
    expect(CrmImportApply.description).toContain('replay is safe');
    expect(CrmImportApply.flags.yes).toBeDefined();
  });

  test('bounds human output without changing complete JSON responses', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderCrmImportPlan({
        ...plan,
        summary: {...plan.summary, total: 51},
        operations: Array.from({length: 51}, (_, index) => ({
          ...plan.operations[0],
          id: `record-${index}`,
        })),
      });
      expect(log.mock.calls.map(call => call.join(' ')).join('\n'))
        .toContain('Showing 50 of 51 operations');
    } finally {
      log.mockRestore();
    }
  });
});
