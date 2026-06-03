import {
  toolArgPreview,
  toolCallLabel,
  clipOutput,
  gutterIndent,
  OUTPUT_MAX_LINES,
} from '../../interactive-tui/toolView';

describe('toolView — tool call labels', () => {
  it('toolArgPreview picks the most salient arg', () => {
    expect(toolArgPreview({path: 'src/a.ts', other: 1})).toBe('path=src/a.ts');
    expect(toolArgPreview({query: 'find me'})).toBe('query=find me');
  });

  it('toolArgPreview prefers command/cmd and joins array commands', () => {
    expect(toolArgPreview({command: ['bash', '-lc', 'ls -la']})).toBe('command=bash -lc ls -la');
    expect(toolArgPreview({cmd: 'git status'})).toBe('cmd=git status');
  });

  it('toolArgPreview renders file descriptor arrays without object placeholders', () => {
    expect(toolArgPreview({
      files: [
        {path: 'packages/exf-cli/interactive-tui/brain.ts', startLine: 344, endLine: 387},
        {path: 'packages/exf-cli/interactive-tui/toolView.ts'},
      ],
    })).toBe('files=packages/exf-cli/interactive-tui/brain.ts:344-387 packages/exf-cli/intera…');
  });

  it('toolArgPreview falls back to the first stringifiable arg', () => {
    expect(toolArgPreview({weird: 'value'})).toBe('weird=value');
    expect(toolArgPreview({})).toBe('');
    expect(toolArgPreview(undefined)).toBe('');
  });

  it('toolCallLabel uses codex detail when present, args otherwise', () => {
    expect(toolCallLabel('npm test', {path: 'x'})).toBe('npm test');
    expect(toolCallLabel(undefined, {path: 'x'})).toBe('path=x');
    expect(toolCallLabel('   ', {query: 'q'})).toBe('query=q');
  });

  it('toolCallLabel clips very long labels', () => {
    const long = 'x'.repeat(200);
    const label = toolCallLabel(long, undefined);
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('toolView — output clipping', () => {
  it('returns empty for whitespace-only output', () => {
    expect(clipOutput('')).toBe('');
    expect(clipOutput('   \n  \n')).toBe('');
  });

  it('passes short output through, trimming trailing whitespace', () => {
    expect(clipOutput('hello\nworld\n\n')).toBe('hello\nworld');
  });

  it('caps long output at OUTPUT_MAX_LINES with a marker', () => {
    const many = Array.from({length: 20}, (_, i) => `line ${i}`).join('\n');
    const out = clipOutput(many);
    const lines = out.split('\n');
    expect(lines).toHaveLength(OUTPUT_MAX_LINES + 1);
    expect(lines[0]).toBe('line 0');
    expect(lines[OUTPUT_MAX_LINES]).toBe(`… +${20 - OUTPUT_MAX_LINES} more lines`);
  });

  it('caps very large byte output with a truncation marker', () => {
    const huge = 'a'.repeat(5000);
    const out = clipOutput(huge);
    expect(out).toContain('… output truncated');
    expect(out.length).toBeLessThan(5000);
  });
});

describe('toolView — gutter', () => {
  it('indents every line with a gutter', () => {
    expect(gutterIndent('a\nb')).toBe('  ▏ a\n  ▏ b');
  });
});
