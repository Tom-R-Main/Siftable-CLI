import {createHash, randomBytes} from 'node:crypto';

export const SIFT_DOTENV_DIALECT = 'sift-dotenv-v1' as const;
export const MAX_DOTENV_IMPORT_BYTES = 128 * 1024;
export const MAX_DOTENV_IMPORT_ENTRIES = 500;

export type DotenvDuplicateClass = 'none' | 'source_duplicate_first' | 'source_duplicate_later';

export interface ParsedDotenvImportEntry {
  sourceIndex: number;
  key: string;
  value: string;
  line: number;
  column: number;
  duplicateClass: DotenvDuplicateClass;
}

export interface ValueFreeDotenvImportEntry {
  sourceIndex: number;
  key: string;
  line: number;
  column: number;
  duplicateClass: DotenvDuplicateClass;
}

export interface ParsedDotenvImport {
  dialect: typeof SIFT_DOTENV_DIALECT;
  entries: ParsedDotenvImportEntry[];
}

export class DotenvImportParseError extends Error {
  readonly code: string;
  readonly line: number;
  readonly column: number;

  constructor(code: string, line: number, column: number, message: string) {
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'DotenvImportParseError';
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

function decodeUtf8(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(raw);
  } catch {
    throw new DotenvImportParseError('invalid_utf8', 1, 1, 'Source must be valid UTF-8');
  }
}

function isHorizontalSpace(character: string): boolean {
  return character === ' ' || character === '\t';
}

function isNameStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isNameContinue(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function escapedDoubleQuotedValue(
  text: string,
  index: number,
  line: number,
  column: number,
): {value: string; index: number; line: number; column: number} {
  let value = '';
  let cursor = index;
  let currentLine = line;
  let currentColumn = column;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === '"') {
      return {value, index: cursor + 1, line: currentLine, column: currentColumn + 1};
    }
    if (character === '\r' || character === '\n') {
      const width = character === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
      value += '\n';
      cursor += width;
      currentLine += 1;
      currentColumn = 1;
      continue;
    }
    if (character !== '\\') {
      value += character;
      cursor += 1;
      currentColumn += 1;
      continue;
    }
    const escaped = text[cursor + 1];
    if (escaped === undefined || escaped === '\r' || escaped === '\n') {
      throw new DotenvImportParseError(
        'invalid_escape', currentLine, currentColumn, 'Backslash must introduce a supported escape',
      );
    }
    const replacements: Record<string, string> = {
      '"': '"',
      '$': '$',
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (!Object.prototype.hasOwnProperty.call(replacements, escaped)) {
      throw new DotenvImportParseError(
        'unsupported_escape', currentLine, currentColumn, 'Double-quoted value contains an unsupported escape',
      );
    }
    value += replacements[escaped];
    cursor += 2;
    currentColumn += 2;
  }
  throw new DotenvImportParseError('unterminated_quote', line, column - 1, 'Double-quoted value is not terminated');
}

function singleQuotedValue(
  text: string,
  index: number,
  line: number,
  column: number,
): {value: string; index: number; line: number; column: number} {
  let value = '';
  let cursor = index;
  let currentLine = line;
  let currentColumn = column;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character === "'") {
      return {value, index: cursor + 1, line: currentLine, column: currentColumn + 1};
    }
    if (character === '\r' || character === '\n') {
      const width = character === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
      value += '\n';
      cursor += width;
      currentLine += 1;
      currentColumn = 1;
      continue;
    }
    value += character;
    cursor += 1;
    currentColumn += 1;
  }
  throw new DotenvImportParseError('unterminated_quote', line, column - 1, 'Single-quoted value is not terminated');
}

function finishQuotedRecord(
  text: string,
  index: number,
  line: number,
  column: number,
): {index: number; line: number; column: number} {
  let cursor = index;
  let currentColumn = column;
  while (cursor < text.length && isHorizontalSpace(text[cursor]!)) {
    cursor += 1;
    currentColumn += 1;
  }
  if (text[cursor] === '#') {
    while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor += 1;
  } else if (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') {
    throw new DotenvImportParseError(
      'trailing_characters', line, currentColumn, 'Only whitespace or a comment may follow a quoted value',
    );
  }
  if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
  else if (text[cursor] === '\r' || text[cursor] === '\n') cursor += 1;
  return {index: cursor, line: line + 1, column: 1};
}

function unquotedValue(text: string, index: number): {value: string; index: number} {
  let cursor = index;
  let valueEnd = index;
  while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') {
    if (text[cursor] === '#' && (cursor === index || isHorizontalSpace(text[cursor - 1]!))) break;
    cursor += 1;
    valueEnd = cursor;
  }
  while (valueEnd > index && isHorizontalSpace(text[valueEnd - 1]!)) valueEnd -= 1;
  while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor += 1;
  if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
  else if (text[cursor] === '\r' || text[cursor] === '\n') cursor += 1;
  return {value: text.slice(index, valueEnd), index: cursor};
}

export function parseDotenvImport(raw: Buffer): ParsedDotenvImport {
  if (raw.length > MAX_DOTENV_IMPORT_BYTES) {
    throw new DotenvImportParseError('source_too_large', 1, 1, 'Source exceeds the 128 KiB import limit');
  }
  let text = decodeUtf8(raw);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const entries: ParsedDotenvImportEntry[] = [];
  let index = 0;
  let line = 1;
  while (index < text.length) {
    let column = 1;
    while (index < text.length && isHorizontalSpace(text[index]!)) {
      index += 1;
      column += 1;
    }
    if (index >= text.length) break;
    if (text[index] === '\r' || text[index] === '\n') {
      if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
      else index += 1;
      line += 1;
      continue;
    }
    if (text[index] === '#') {
      while (index < text.length && text[index] !== '\r' && text[index] !== '\n') index += 1;
      continue;
    }

    if (text.startsWith('export', index) && isHorizontalSpace(text[index + 6] ?? '')) {
      index += 6;
      column += 6;
      while (index < text.length && isHorizontalSpace(text[index]!)) {
        index += 1;
        column += 1;
      }
    }

    const keyLine = line;
    const keyColumn = column;
    if (!isNameStart(text[index] ?? '')) {
      throw new DotenvImportParseError('invalid_name', line, column, 'Environment name must start with a letter or underscore');
    }
    const keyStart = index;
    while (index < text.length && isNameContinue(text[index]!)) {
      index += 1;
      column += 1;
    }
    const key = text.slice(keyStart, index);
    if (key.length > 128) {
      throw new DotenvImportParseError(
        'invalid_name', keyLine, keyColumn + 128, 'Environment name exceeds 128 characters',
      );
    }
    while (index < text.length && isHorizontalSpace(text[index]!)) {
      index += 1;
      column += 1;
    }
    if (text[index] !== '=') {
      throw new DotenvImportParseError('missing_equals', line, column, 'Environment assignment requires =');
    }
    index += 1;
    column += 1;
    while (index < text.length && isHorizontalSpace(text[index]!)) {
      index += 1;
      column += 1;
    }

    let value: string;
    if (text[index] === '"') {
      const parsed = escapedDoubleQuotedValue(text, index + 1, line, column + 1);
      value = parsed.value;
      const finished = finishQuotedRecord(text, parsed.index, parsed.line, parsed.column);
      index = finished.index;
      line = finished.line;
    } else if (text[index] === "'") {
      const parsed = singleQuotedValue(text, index + 1, line, column + 1);
      value = parsed.value;
      const finished = finishQuotedRecord(text, parsed.index, parsed.line, parsed.column);
      index = finished.index;
      line = finished.line;
    } else {
      const parsed = unquotedValue(text, index);
      value = parsed.value;
      index = parsed.index;
      line += 1;
    }
    entries.push({
      sourceIndex: entries.length,
      key,
      value,
      line: keyLine,
      column: keyColumn,
      duplicateClass: 'none',
    });
    if (entries.length > MAX_DOTENV_IMPORT_ENTRIES) {
      throw new DotenvImportParseError(
        'too_many_entries', keyLine, keyColumn, 'Source exceeds the 500-entry import limit',
      );
    }
  }

  const occurrences = new Map<string, number[]>();
  entries.forEach((entry, entryIndex) => {
    const keyEntries = occurrences.get(entry.key) ?? [];
    keyEntries.push(entryIndex);
    occurrences.set(entry.key, keyEntries);
  });
  for (const indexes of occurrences.values()) {
    if (indexes.length < 2) continue;
    indexes.forEach((entryIndex, duplicateIndex) => {
      entries[entryIndex]!.duplicateClass = duplicateIndex === 0
        ? 'source_duplicate_first'
        : 'source_duplicate_later';
    });
  }

  return {dialect: SIFT_DOTENV_DIALECT, entries};
}

export function valueFreeDotenvEntries(entries: ParsedDotenvImportEntry[]): ValueFreeDotenvImportEntry[] {
  return entries.map(({sourceIndex, key, line, column, duplicateClass}) => ({
    sourceIndex,
    key,
    line,
    column,
    duplicateClass,
  }));
}

export function createDotenvSourceBinding(raw: Buffer, nonce = randomBytes(32).toString('base64url')): {
  sourceNonce: string;
  sourceDigest: string;
} {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('Source binding nonce is invalid');
  return {
    sourceNonce: nonce,
    sourceDigest: createHash('sha256').update(nonce, 'utf8').update(raw).digest('hex'),
  };
}
