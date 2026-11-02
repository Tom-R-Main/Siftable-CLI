import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as XLSX from 'xlsx';
import {runCommand} from '../helpers/mock-api';

let workspace: string;
const originalFetch = global.fetch;

function write(name: string, contents: string | Uint8Array): string {
  const target = join(workspace, name);
  writeFileSync(target, contents);
  return target;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cli-inspect-file-'));
  // No mock API is installed anywhere in this suite. Any network access is a
  // hard failure, which is what proves the command is purely local.
  global.fetch = (() => {
    throw new Error('inspect-file attempted network access');
  }) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  rmSync(workspace, {recursive: true, force: true});
});

describe('datasets inspect-file', () => {
  it('returns the tabular-import evidence envelope in JSON mode without a token', async () => {
    const filePath = write('people.csv', 'Name,Amount\nAda,5\nBob,7\n');

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);

    const inspection = parsed.inspection;
    expect(inspection.filename).toBe('people.csv');
    expect(inspection.format).toBe('csv');
    expect(inspection.delimiter).toBe(',');
    expect(inspection.fileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inspection.engine).toBeDefined();
    expect(inspection.sheetInventory).toEqual(['Sheet1']);
    expect(inspection.sheetTruncation).toEqual({total: 1, returned: 1, truncated: false});

    const sheet = inspection.sheets[0];
    expect(sheet.headers).toEqual(['Name', 'Amount']);
    expect(sheet.headerSourceRowNumber).toBe(1);
    expect(sheet.sourceColumnNumbers).toEqual([1, 2]);
    expect(sheet.rows[0].sourceRowNumber).toBe(2);
    expect(sheet.rows[0].originalCells).toEqual(['Ada', '5']);
    expect(sheet.rows[0].valueTypes).toEqual(['string', 'number']);
    expect(sheet.truncation).toEqual({
      rows: {total: 2, returned: 2, truncated: false},
      columns: {total: 2, returned: 2, truncated: false},
    });
  });

  it('reports formula cells and risks without evaluating them', async () => {
    const worksheet = XLSX.utils.aoa_to_sheet([['Label', 'Payload'], ['a', null]]);
    worksheet.B2 = {t: 'n', v: 3, f: 'WEBSERVICE("http://example.test")'};
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const filePath = write('risky.xlsx', new Uint8Array(
      XLSX.write(workbook, {type: 'array', bookType: 'xlsx'}) as ArrayBuffer,
    ));

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    const formula = parsed.inspection.sheets[0].rows[0].formulaCells[0];
    expect(formula.formula).toBe('WEBSERVICE("http://example.test")');
    expect(formula.risks).toContain('network_function');
    expect(formula.sourceColumnNumber).toBe(2);
  });

  it('selects a single sheet while still listing the whole workbook', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name'], ['Ada']]), 'Accounts');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Team'], ['Ops']]), 'Teams');
    const filePath = write('books.xlsx', new Uint8Array(
      XLSX.write(workbook, {type: 'array', bookType: 'xlsx'}) as ArrayBuffer,
    ));

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--sheet', 'Teams', '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.inspection.sheets.map((sheet: {name: string}) => sheet.name)).toEqual(['Teams']);
    expect(parsed.inspection.sheetInventory).toEqual(['Accounts', 'Teams']);
    expect(parsed.inspection.sheetTruncation).toEqual({total: 2, returned: 1, truncated: true});
  });

  it('bounds rows by default and reports the truncation', async () => {
    const rows = Array.from({length: 400}, (_, index) => `person-${index},${index}`).join('\n');
    const filePath = write('large.csv', `Name,Amount\n${rows}\n`);

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.inspection.sheets[0].rows).toHaveLength(100);
    expect(parsed.inspection.sheets[0].truncation.rows).toEqual({
      total: 400,
      returned: 100,
      truncated: true,
    });
    expect(parsed.inspection.truncated).toBe(true);
  });

  it('renders a human-readable summary including risks', async () => {
    const filePath = write('injection.csv', 'Name,Payload\nAda,=cmd|\' /C calc\'\n');

    const result = await runCommand(['datasets', 'inspect-file', filePath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('injection.csv');
    expect(result.stdout).toContain('sha256:');
    expect(result.stdout).toContain('Formula cells: 1');
    expect(result.stdout).toContain('csv_injection_pattern');
    expect(result.stdout).toContain('Diagnostics');
  });

  it('fails non-zero on an unsupported format while still emitting diagnostics', async () => {
    const filePath = write('rows.jsonl', '{"a":1}\n');

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.inspection.sheets).toEqual([]);
    expect(parsed.inspection.errors.map((error: {code: string}) => error.code)).toContain('unsupported_format');
  });

  it('fails non-zero on an unknown sheet with the available sheets named', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name'], ['Ada']]), 'Accounts');
    const filePath = write('one-sheet.xlsx', new Uint8Array(
      XLSX.write(workbook, {type: 'array', bookType: 'xlsx'}) as ArrayBuffer,
    ));

    const result = await runCommand(['datasets', 'inspect-file', filePath, '--sheet', 'Nope', '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.inspection.errors[0].code).toBe('sheet_not_found');
    expect(parsed.inspection.errors[0].message).toContain('Accounts');
  });

  it('fails non-zero when the file cannot be read at all', async () => {
    const missing = join(workspace, 'absent.csv');
    const result = await runCommand(['datasets', 'inspect-file', missing]);

    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? '').toContain('File not found');
  });

  it('fails non-zero on an empty file', async () => {
    const filePath = write('empty.csv', '');
    const result = await runCommand(['datasets', 'inspect-file', filePath]);

    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? '').toContain('File is empty');
  });
});
