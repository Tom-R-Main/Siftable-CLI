import {afterEach, describe, expect, it} from 'vitest';
import {
  CsvMappingRequiredError,
  formatMappingSuggestions,
  MAX_CSV_CELL_BYTES,
  parseCsvImport,
  suggestCsvMapping,
  valueFreeCsvEntries,
} from '../src/lib/csvImport.js';

const SENTINEL = 'synthetic-sentinel-value-9f3c';

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'), 'utf8');
}

function mapping(name = 'Key', value = 'Secret Value') {
  return {name, value};
}

afterEach(() => {
  // No global stubs in this suite.
});

describe('sift-csv-v1 local parsing', () => {
  it('parses a mapped source with row numbers and ok classification', () => {
    const parsed = parseCsvImport(
      csv(['Key,Secret Value', `API_TOKEN,${SENTINEL}`, 'OTHER,plain']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    );
    expect(parsed.dialect).toBe('sift-csv-v1');
    expect(parsed.columnCount).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      sourceIndex: 0, key: 'API_TOKEN', rowNumber: 2, duplicateClass: 'none', rowClass: 'ok',
    });
    expect(parsed.entries[0]!.value).toBe(SENTINEL);
    expect(parsed.entries[1]).toMatchObject({key: 'OTHER', rowNumber: 3, rowClass: 'ok'});
  });

  it('requires explicit mapping and suggests without deciding', () => {
    let caught: unknown;
    try {
      parseCsvImport(csv(['Key,Secret Value', 'A,1']), {filename: 'legacy.csv', delimiter: ',', headerRow: 1});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CsvMappingRequiredError);
    const suggestions = formatMappingSuggestions(['Key', 'Secret Value'], 1, ',');
    expect(suggestions).toContain('[0] "Key"');
    expect(suggestions).toContain('--map name="Key"');
    expect(suggestCsvMapping(['Key', 'Secret Value'])).toEqual({name: 'Key', value: 'Secret Value'});
  });

  it('classifies blank, invalid, mismatched, and oversized rows without excerpts', () => {
    const big = 'x'.repeat(MAX_CSV_CELL_BYTES + 1);
    const parsed = parseCsvImport(
      csv(['Key,Secret Value,Owner', ',empty-name', `9BAD,${SENTINEL},`, `FOREIGN,x,someone`, `BIG,${big},`]),
      {
        filename: 'legacy.csv', delimiter: ',', headerRow: 1,
        mapping: {...mapping(), owner: 'Owner'},
      },
    );
    expect(parsed.entries.map((entry) => entry.rowClass)).toEqual([
      'blank_name', 'invalid_name', 'owner_mismatch', 'oversize_cell',
    ]);
    for (const entry of parsed.entries) {
      expect(entry.duplicateClass).toBe('none');
    }
  });

  it('bounds the reported key of an overlong invalid name so the plan request stays valid', () => {
    const longName = 'NAME-' + 'x'.repeat(300);
    const parsed = parseCsvImport(
      csv(['Key,Secret Value', `${longName},${SENTINEL}`, 'GOOD,v']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    );
    expect(parsed.entries.map((entry) => entry.rowClass)).toEqual(['invalid_name', 'ok']);
    expect(parsed.entries[0].key.length).toBe(128);
    expect(parsed.entries[0].key).toBe(longName.slice(0, 128));
    expect(parsed.entries[1].key).toBe('GOOD');
    const payload = JSON.stringify(valueFreeCsvEntries(parsed.entries));
    expect(payload).not.toContain(SENTINEL);
    expect(payload).not.toContain(longName);
  });

  it('marks source duplicates first and later over ok rows only', () => {
    const parsed = parseCsvImport(
      csv(['Key,Secret Value', 'DUP,one', ',blank', 'DUP,two']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    );
    expect(parsed.entries.map((entry) => entry.duplicateClass)).toEqual([
      'source_duplicate_first', 'none', 'source_duplicate_later',
    ]);
  });

  it('references ambiguous headers by deduplicated display name', () => {
    const parsed = parseCsvImport(
      csv(['Key,Value,Value', 'A,first,second']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: {name: 'Key', value: 'Value (2)'}},
    );
    expect(parsed.entries[0]).toMatchObject({key: 'A', value: 'second', rowClass: 'ok'});
    // The raw duplicated name is refused: it must name exactly one column.
    expect(() => parseCsvImport(
      csv(['Key,Value,Value', 'A,first,second']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: {name: 'Key', value: 'Value'}},
    )).toThrow(/ambiguous.*Value.*Value \(2\)/);
  });

  it('rejects malformed CSV, bad UTF-8, and oversized sources with positions only', () => {
    expect(() => parseCsvImport(
      csv(['Key,Secret Value', '"unterminated,cell']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    )).toThrow(/row \d+, column \d+/);
    expect(() => parseCsvImport(
      Buffer.from([0xff, 0xfe, 0x41]),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    )).toThrow(/row 1, column 1/);
    expect(() => parseCsvImport(
      Buffer.alloc(257 * 1024, 'a'),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    )).toThrow(/256 KiB/);
  });

  it('reports injection-shaped cells by position without content', () => {
    const parsed = parseCsvImport(
      csv(['Key,Secret Value', '=HYPERLINK(evil),plain']),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    );
    expect(parsed.injectionWarnings).toEqual([{rowNumber: 2, columnNumber: 1}]);
    expect(JSON.stringify(parsed.injectionWarnings)).not.toContain('HYPERLINK');
  });

  it('strips values for the value-free plan payload', () => {
    const parsed = parseCsvImport(
      csv(['Key,Secret Value', `API_TOKEN,${SENTINEL}`]),
      {filename: 'legacy.csv', delimiter: ',', headerRow: 1, mapping: mapping()},
    );
    const free = valueFreeCsvEntries(parsed.entries);
    expect(JSON.stringify(free)).not.toContain(SENTINEL);
    expect(free[0]).not.toHaveProperty('value');
    expect(free[0]).toMatchObject({sourceIndex: 0, key: 'API_TOKEN', rowNumber: 2});
  });
});
