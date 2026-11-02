import {classifyDelimitedInjection, parseTabularText} from '@siftable/tabular-import';

export const SIFT_CSV_DIALECT = 'sift-csv-v1' as const;
export const MAX_CSV_IMPORT_BYTES = 256 * 1024;
export const MAX_CSV_IMPORT_ROWS = 500;
export const MAX_CSV_CELL_BYTES = 128 * 1024;
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;

export type CsvRowClass = 'ok' | 'invalid_name' | 'blank_name' | 'owner_mismatch' | 'oversize_cell';
export type CsvDuplicateClass = 'none' | 'source_duplicate_first' | 'source_duplicate_later';

export interface CsvFieldMapping {
  name: string;
  value: string;
  owner?: string;
  description?: string;
  tags?: string;
}

export interface ParsedCsvImportEntry {
  sourceIndex: number;
  key: string;
  value: string;
  rowNumber: number;
  duplicateClass: CsvDuplicateClass;
  rowClass: CsvRowClass;
}

export interface ValueFreeCsvImportEntry {
  sourceIndex: number;
  key: string;
  rowNumber: number;
  duplicateClass: CsvDuplicateClass;
  rowClass: CsvRowClass;
}

export interface CsvInjectionWarning {
  rowNumber: number;
  columnNumber: number;
}

export interface ParsedCsvImport {
  dialect: typeof SIFT_CSV_DIALECT;
  delimiter: string;
  headerRowNumber: number;
  columnCount: number;
  headers: string[];
  entries: ParsedCsvImportEntry[];
  injectionWarnings: CsvInjectionWarning[];
}

export class CsvImportParseError extends Error {
  readonly code: string;
  readonly rowNumber: number;
  readonly columnNumber: number;

  constructor(code: string, rowNumber: number, columnNumber: number, message: string) {
    // Never include cell excerpts: row/column position only.
    super(`${message} at row ${rowNumber}, column ${columnNumber}`);
    this.name = 'CsvImportParseError';
    this.code = code;
    this.rowNumber = rowNumber;
    this.columnNumber = columnNumber;
  }
}

export class CsvMappingRequiredError extends Error {
  readonly headers: string[];
  readonly headerRowNumber: number;
  readonly delimiter: string;

  constructor(headers: string[], headerRowNumber: number, delimiter: string) {
    super('CSV import requires an explicit header mapping. Detected headers are listed; review before use.');
    this.name = 'CsvMappingRequiredError';
    this.headers = headers;
    this.headerRowNumber = headerRowNumber;
    this.delimiter = delimiter;
  }
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_CSV_REPORTED_KEY_CHARS = 128;

/**
 * Deterministic JSON with recursively sorted object keys. PostgreSQL jsonb
 * does not preserve key order, so server-returned profiles must be compared
 * canonically rather than by plain JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const DEDUP_SUFFIX = / \(\d+\)$/;

function baseHeaderName(displayed: string): string {
  return displayed.replace(DEDUP_SUFFIX, '');
}

function decodeUtf8(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(raw);
  } catch {
    throw new CsvImportParseError('invalid_utf8', 1, 1, 'Source must be valid UTF-8');
  }
}

function suggestColumn(headers: string[], candidates: string[]): string | null {
  const lowered = headers.map((header) => header.trim().toLowerCase());
  for (const candidate of candidates) {
    const index = lowered.indexOf(candidate);
    if (index >= 0) return headers[index]!;
  }
  return null;
}

export function suggestCsvMapping(headers: string[]): {name: string | null; value: string | null} {
  return {
    name: suggestColumn(headers, ['key', 'name', 'variable', 'env', 'setting']),
    value: suggestColumn(headers, ['value', 'secret value', 'secret', 'password', 'token']),
  };
}

export function formatMappingSuggestions(
  headers: string[],
  headerRowNumber: number,
  delimiter: string,
): string {
  const lines = [
    'CSV import requires an explicit header mapping; nothing was inferred.',
    `Headers (row ${headerRowNumber}): ${headers.map((header, index) => `[${index}] ${JSON.stringify(header)}`).join('  ')}`,
  ];
  const suggested = suggestCsvMapping(headers);
  if (suggested.name && suggested.value) {
    lines.push(
      'Suggested (review before use): '
      + `--header-row ${headerRowNumber} --delimiter ${JSON.stringify(delimiter)} `
      + `--map name=${JSON.stringify(suggested.name)} --map value=${JSON.stringify(suggested.value)}`,
    );
  }
  lines.push('Ambiguous duplicate headers must be referenced by their displayed deduplicated name.');
  return lines.join('\n');
}

export interface ParseCsvImportOptions {
  filename: string;
  delimiter: string;
  headerRow: number;
  mapping?: CsvFieldMapping;
}

export function parseCsvImport(raw: Buffer, options: ParseCsvImportOptions): ParsedCsvImport {
  if (raw.length > MAX_CSV_IMPORT_BYTES) {
    throw new CsvImportParseError('source_too_large', 1, 1, 'Source exceeds the 256 KiB CSV import limit');
  }
  if (!CSV_DELIMITERS.includes(options.delimiter as (typeof CSV_DELIMITERS)[number])) {
    throw new CsvImportParseError('unsupported_delimiter', 1, 1, 'Delimiter must be one of: comma, semicolon, tab, pipe');
  }
  if (!Number.isSafeInteger(options.headerRow) || options.headerRow < 1) {
    throw new CsvImportParseError('invalid_header_row', 1, 1, 'Header row must be a positive line number');
  }
  const text = decodeUtf8(raw);
  const result = parseTabularText(text, {
    filename: options.filename,
    format: 'csv',
    delimiter: options.delimiter,
    headerRow: options.headerRow - 1,
    maxRows: MAX_CSV_IMPORT_ROWS + 1,
  });
  const failure = result.errors[0];
  if (failure) {
    throw new CsvImportParseError(
      'malformed_csv',
      failure.sourceRowNumber ?? 1,
      failure.sourceColumnNumber ?? 1,
      'Source is not well-formed CSV',
    );
  }
  const sheet = result.sheets[0];
  if (!sheet) {
    throw new CsvImportParseError('empty_source', 1, 1, 'CSV source has no readable sheet');
  }
  const headers = sheet.headers;
  if (headers.length < 2) {
    throw new CsvImportParseError('insufficient_columns', options.headerRow, 1, 'CSV source needs at least two columns');
  }
  if (!options.mapping || !options.mapping.name || !options.mapping.value) {
    throw new CsvMappingRequiredError(headers, options.headerRow, options.delimiter);
  }
  const columnIndex = new Map(headers.map((header, index) => [header, index]));
  const resolveColumn = (displayed: string, field: string): number => {
    const index = columnIndex.get(displayed);
    if (index === undefined) {
      throw new CsvImportParseError('unknown_column', options.headerRow, 1, `Mapped ${field} column is not a displayed header`);
    }
    // A raw duplicated header keeps its display name on the first column
    // while later copies gain a deduplicated suffix. Refuse the raw name so
    // the mapping always names exactly one column.
    const rivals = headers.filter((header) => header !== displayed && baseHeaderName(header) === displayed);
    if (rivals.length > 0) {
      const choices = [displayed, ...rivals].map((header) => JSON.stringify(header)).join(', ');
      throw new CsvImportParseError('ambiguous_column', options.headerRow, 1, `Mapped ${field} column is ambiguous; choose one of ${choices}`);
    }
    return index;
  };
  const nameIndex = resolveColumn(options.mapping.name, 'name');
  const valueIndex = resolveColumn(options.mapping.value, 'value');
  if (nameIndex === valueIndex) {
    throw new CsvImportParseError('duplicate_column', options.headerRow, 1, 'Name and value columns must differ');
  }
  const ownerIndex = options.mapping.owner ? resolveColumn(options.mapping.owner, 'owner') : null;
  const descriptionIndex = options.mapping.description ? resolveColumn(options.mapping.description, 'description') : null;
  const tagsIndex = options.mapping.tags ? resolveColumn(options.mapping.tags, 'tags') : null;
  for (const optional of [ownerIndex, descriptionIndex, tagsIndex]) {
    if (optional !== null && (optional === nameIndex || optional === valueIndex)) {
      throw new CsvImportParseError('duplicate_column', options.headerRow, 1, 'Mapped columns must be distinct');
    }
  }
  if (sheet.rows.length > MAX_CSV_IMPORT_ROWS) {
    throw new CsvImportParseError('too_many_rows', sheet.rows[MAX_CSV_IMPORT_ROWS]!.sourceRowNumber, 1, 'CSV source exceeds the 500-row import limit');
  }

  const cellText = (cells: readonly unknown[], index: number): string => {
    const cell = cells[index];
    if (typeof cell === 'string') return cell;
    if (cell === null || cell === undefined) return '';
    return String(cell);
  };
  const cellBytes = (value: string): number => Buffer.byteLength(value, 'utf8');

  const entries: ParsedCsvImportEntry[] = [];
  const injectionWarnings: CsvInjectionWarning[] = [];
  sheet.rows.forEach((row, sourceIndex) => {
    const nameRaw = cellText(row.cells, nameIndex).trim();
    const value = cellText(row.cells, valueIndex);
    const ownerRaw = ownerIndex === null ? '' : cellText(row.cells, ownerIndex).trim();
    let rowClass: CsvRowClass;
    if (nameRaw === '') {
      rowClass = 'blank_name';
    } else if (!ENVIRONMENT_NAME.test(nameRaw)) {
      rowClass = 'invalid_name';
    } else if (ownerRaw !== '') {
      // Fail closed: a non-blank owner cell cannot be proven to name the
      // selected owner, so the row never writes. Plans never fan out.
      rowClass = 'owner_mismatch';
    } else if (
      cellBytes(value) > MAX_CSV_CELL_BYTES
      || cellBytes(nameRaw) > MAX_CSV_CELL_BYTES
      || (descriptionIndex !== null && cellBytes(cellText(row.cells, descriptionIndex)) > MAX_CSV_CELL_BYTES)
      || (tagsIndex !== null && cellBytes(cellText(row.cells, tagsIndex)) > MAX_CSV_CELL_BYTES)
    ) {
      rowClass = 'oversize_cell';
    } else {
      rowClass = 'ok';
    }
    // Injection screening covers name/owner/description/tags cells only.
    // Value cells are never scanned into diagnostics; export rendering guards them.
    for (const [scanIndex, columnNumber] of [
      [nameIndex, nameIndex + 1],
      ...(ownerIndex === null ? [] : [[ownerIndex, ownerIndex + 1] as const]),
      ...(descriptionIndex === null ? [] : [[descriptionIndex, descriptionIndex + 1] as const]),
      ...(tagsIndex === null ? [] : [[tagsIndex, tagsIndex + 1] as const]),
    ]) {
      if (classifyDelimitedInjection(cellText(row.cells, scanIndex)).length > 0) {
        injectionWarnings.push({rowNumber: row.sourceRowNumber, columnNumber});
      }
    }
    entries.push({
      sourceIndex,
      // Non-ok rows never write, and the server bounds every reported key
      // at 128 characters, so an overlong invalid name is truncated for the
      // value-free diagnostic instead of failing the whole plan request.
      key: rowClass === 'ok' ? nameRaw : nameRaw.slice(0, MAX_CSV_REPORTED_KEY_CHARS),
      value,
      rowNumber: row.sourceRowNumber,
      duplicateClass: 'none',
      rowClass,
    });
  });

  // Duplicate classes over ok rows only, mirroring the dotenv importer.
  const byKey = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.rowClass !== 'ok') return;
    const indexes = byKey.get(entry.key) ?? [];
    indexes.push(index);
    byKey.set(entry.key, indexes);
  });
  for (const indexes of byKey.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((entryIndex, duplicateIndex) => {
      entries[entryIndex]!.duplicateClass = duplicateIndex === 0
        ? 'source_duplicate_first'
        : 'source_duplicate_later';
    });
  }
  return {
    dialect: SIFT_CSV_DIALECT,
    delimiter: options.delimiter,
    headerRowNumber: options.headerRow,
    columnCount: headers.length,
    headers,
    entries,
    injectionWarnings,
  };
}

export function valueFreeCsvEntries(entries: ParsedCsvImportEntry[]): ValueFreeCsvImportEntry[] {
  return entries.map(({sourceIndex, key, rowNumber, duplicateClass, rowClass}) => ({
    sourceIndex,
    key,
    rowNumber,
    duplicateClass,
    rowClass,
  }));
}
