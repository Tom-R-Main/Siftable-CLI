import {renderDetail, renderTable, sanitizeTerminalLine, sanitizeTerminalText} from '../../src/lib/output';

describe('output helpers', () => {
  const originalLog = console.log;
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
  });

  afterAll(() => {
    console.log = originalLog;
  });

  it('sanitizes terminal control characters without changing ordinary text', () => {
    expect(sanitizeTerminalText('\u001B[31mred\u001B[0m\u202Eabc\u200B')).toBe('redabc');
    expect(sanitizeTerminalText('ordinary text')).toBe('ordinary text');
    expect(sanitizeTerminalLine('first\r\nsecond')).toBe('first second');
    expect(sanitizeTerminalLine('first\tsecond')).toBe('first second');
  });

  it('sanitizes values rendered in tables and details', () => {
    renderDetail([['Title', '\u001B[31mSource\u001B[0m\u202E\nDetail']]);
    renderTable([{title: 'Hidden\u200BTitle\nTable'}], [{key: 'title', header: 'Title'}]);

    expect(lines.join('\n')).toContain('Source');
    expect(lines.join('\n')).toContain('HiddenTitle');
    expect(lines.join('\n')).toContain('Source Detail');
    expect(lines.join('\n')).toContain('HiddenTitle Table');
    expect(lines.join('\n')).not.toContain('\nDetail');
    expect(lines.join('\n')).not.toContain('\nTable');
    expect(lines.join('\n')).not.toContain('\u001B');
    expect(lines.join('\n')).not.toContain('\u202E');
    expect(lines.join('\n')).not.toContain('\u200B');
  });
});
