import {describe, expect, it} from 'vitest';
import {
  createDotenvSourceBinding,
  DotenvImportParseError,
  parseDotenvImport,
  valueFreeDotenvEntries,
} from '../src/lib/dotenvImport.js';

function parse(source: string | Buffer) {
  return parseDotenvImport(Buffer.isBuffer(source) ? source : Buffer.from(source));
}

describe('Sift dotenv import dialect', () => {
  it('parses BOM, CRLF, export prefixes, comments, quoting, escapes, and multiline values', () => {
    const parsed = parse(Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from([
        '# header',
        'export TOKEN = unquoted value # comment',
        'EMPTY=',
        'SINGLE=\'literal $VALUE # retained\'',
        'DOUBLE="line one\\nline two\\t\\$VALUE"',
        'MULTILINE="first',
        'second" # trailing comment',
        '',
      ].join('\r\n')),
    ]));

    expect(parsed.entries.map(({key, value, line, column}) => ({key, value, line, column}))).toEqual([
      {key: 'TOKEN', value: 'unquoted value', line: 2, column: 8},
      {key: 'EMPTY', value: '', line: 3, column: 1},
      {key: 'SINGLE', value: 'literal $VALUE # retained', line: 4, column: 1},
      {key: 'DOUBLE', value: 'line one\nline two\t$VALUE', line: 5, column: 1},
      {key: 'MULTILINE', value: 'first\nsecond', line: 6, column: 1},
    ]);
  });

  it('treats interpolation syntax literally and classifies every duplicate occurrence', () => {
    const parsed = parse('A=${B}\nA="$B"\nB=value\n');
    expect(parsed.entries.map(({key, value, duplicateClass}) => ({key, value, duplicateClass}))).toEqual([
      {key: 'A', value: '${B}', duplicateClass: 'source_duplicate_first'},
      {key: 'A', value: '$B', duplicateClass: 'source_duplicate_later'},
      {key: 'B', value: 'value', duplicateClass: 'none'},
    ]);
  });

  it('emits value-free metadata and a nonce-scoped raw-source binding', () => {
    const raw = Buffer.from('TOKEN=synthetic-secret\n');
    const parsed = parse(raw);
    const metadata = valueFreeDotenvEntries(parsed.entries);
    const binding = createDotenvSourceBinding(raw, 'A'.repeat(43));
    expect(metadata).toEqual([{
      sourceIndex: 0,
      key: 'TOKEN',
      line: 1,
      column: 1,
      duplicateClass: 'none',
    }]);
    expect(JSON.stringify(metadata)).not.toContain('synthetic-secret');
    expect(binding.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(createDotenvSourceBinding(raw, 'A'.repeat(43))).toEqual(binding);
    expect(createDotenvSourceBinding(Buffer.from('TOKEN=changed\n'), 'A'.repeat(43)).sourceDigest)
      .not.toBe(binding.sourceDigest);
    expect(createDotenvSourceBinding(raw, 'B'.repeat(43)).sourceDigest).not.toBe(binding.sourceDigest);
  });

  it.each([
    ['1BAD=value', 'invalid_name', 1, 1],
    ['NAME value', 'missing_equals', 1, 6],
    ['NAME="unterminated', 'unterminated_quote', 1, 6],
    ['NAME="bad\\q"', 'unsupported_escape', 1, 10],
    ['NAME="ok" trailing', 'trailing_characters', 1, 11],
    [`${'A'.repeat(129)}=value`, 'invalid_name', 1, 129],
  ])('rejects ambiguous input without a value excerpt: %s', (source, code, line, column) => {
    try {
      parse(source);
      throw new Error('expected parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DotenvImportParseError);
      expect(error).toMatchObject({code, line, column});
      expect(String(error)).not.toContain('unterminated');
      expect(String(error)).not.toContain('bad\\q');
      expect(String(error)).not.toContain('trailing');
    }
  });

  it('rejects invalid UTF-8 without decoding bytes into the error', () => {
    expect(() => parse(Buffer.from([0x54, 0x4F, 0x4B, 0x45, 0x4E, 0x3D, 0xC3, 0x28])))
      .toThrowError(expect.objectContaining({code: 'invalid_utf8', line: 1, column: 1}));
  });

  it('accepts CR-only records and ignores a trailing whitespace-only final record', () => {
    const parsed = parseDotenvImport(Buffer.from('FIRST=one\rSECOND=two\r   '));
    expect(parsed.entries).toEqual([
      expect.objectContaining({key: 'FIRST', value: 'one', line: 1}),
      expect.objectContaining({key: 'SECOND', value: 'two', line: 2}),
    ]);
  });
});
