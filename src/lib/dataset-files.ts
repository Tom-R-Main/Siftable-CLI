import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseTabularText} from '@siftable/tabular-import';

export interface ParsedDatasetRows {
  headers: string[];
  rows: Array<{fields: Record<string, unknown>}>;
}

export function parseDatasetRows(filePath: string): ParsedDatasetRows {
  const text = fs.readFileSync(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.jsonl' || extension === '.ndjson') {
    return parseJSONL(text);
  }

  if (extension === '.json') {
    return parseJSON(text);
  }

  return parseCSV(text, path.basename(filePath), extension === '.tsv' ? '\t' : ',');
}

export function collectHeaders(rows: Array<{fields: Record<string, unknown>}>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.fields)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

export function inferFieldType(values: unknown[]): string {
  let nums = 0;
  let bools = 0;
  let dates = 0;
  let total = 0;

  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue;
    total++;
    if (typeof value === 'boolean' || ['true', 'false'].includes(String(value).toLowerCase())) bools++;
    if (!Number.isNaN(Number(value)) && String(value).trim() !== '') nums++;
    if (Number.isNaN(Number(value)) && isDateLikeString(value)) dates++;
  }

  if (total === 0) return 'text';
  if (bools / total > 0.8) return 'checkbox';
  if (nums / total > 0.8) return 'number';
  if (dates / total > 0.8) return 'date';
  return 'text';
}

function isDateLikeString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  const hasExplicitDateShape =
    /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s].*)?$/.test(trimmed)
    || /^\d{4}\/\d{1,2}\/\d{1,2}(?:\s.*)?$/.test(trimmed)
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s.*)?$/.test(trimmed);

  return hasExplicitDateShape && !Number.isNaN(Date.parse(trimmed));
}

function parseJSON(text: string): ParsedDatasetRows {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON import file.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('JSON import file must contain an array of objects.');
  }

  const rows = parsed.map((item, index) => normalizeJsonRow(item, index + 1));
  return {headers: collectHeaders(rows), rows};
}

function parseJSONL(text: string): ParsedDatasetRows {
  const rows: Array<{fields: Record<string, unknown>}> = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      rows.push(normalizeJsonRow(JSON.parse(line), index + 1));
    } catch {
      throw new Error(`Invalid JSONL at line ${index + 1}.`);
    }
  });

  return {headers: collectHeaders(rows), rows};
}

function normalizeJsonRow(item: unknown, rowNumber: number): {fields: Record<string, unknown>} {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Import row ${rowNumber} must be an object.`);
  }

  const candidate = item as Record<string, unknown>;
  const fields = candidate.fields;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    return {fields: fields as Record<string, unknown>};
  }

  return {fields: candidate};
}

function parseCSV(text: string, filename: string, delimiter: ',' | '\t'): ParsedDatasetRows {
  const parsed = parseTabularText(text, {filename, delimiter});
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0]?.message ?? 'Invalid delimited import file.');
  }
  const sheet = parsed.sheets[0];
  const headers = sheet?.headers ?? [];
  const rows = (sheet?.rows ?? []).map((row) => {
    const fields: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      fields[header] = row.cells[index] ?? '';
    });
    return {fields};
  });
  return {headers, rows};
}
