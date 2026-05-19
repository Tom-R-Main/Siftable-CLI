import {renderDetail, renderTable, sanitizeTerminalText} from '../../src/lib/output';

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
  });

  it('sanitizes values rendered in tables and details', () => {
    renderDetail([['Title', '\u001B[31mSource\u001B[0m\u202E']]);
    renderTable([{title: 'Hidden\u200BTitle'}], [{key: 'title', header: 'Title'}]);

    expect(lines.join('\n')).toContain('Source');
    expect(lines.join('\n')).toContain('HiddenTitle');
    expect(lines.join('\n')).not.toContain('\u001B');
    expect(lines.join('\n')).not.toContain('\u202E');
    expect(lines.join('\n')).not.toContain('\u200B');
  });
});
