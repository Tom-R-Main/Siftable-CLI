import {
  asExplorerActivityView,
  explorerToolCallText,
  formatExplorerActivityDetails,
  formatExplorerActivityLine,
  isExplorerToolName,
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

  it('special-cases explorer tool calls', () => {
    expect(isExplorerToolName('repo_explorer')).toBe(true);
    expect(isExplorerToolName('repo_explorer_fanout')).toBe(true);
    expect(isExplorerToolName('read_file')).toBe(false);
    expect(explorerToolCallText('repo_explorer_fanout', 'read-only parallel scouts')).toBe(
      '◇ Explorer · fan-out · read-only parallel scouts',
    );
  });
});

describe('toolView — explorer activity', () => {
  const activity = {
    mode: 'fanout' as const,
    cacheHit: true,
    elapsedMs: 211,
    reportChars: 7980,
    suggestedFileCount: 14,
    usedSuggestedFileCount: 5,
    primaryCandidates: [
      'packages/exf-cli/interactive-tui/explorer.ts',
      'packages/exf-cli/interactive-tui/brain.ts',
    ],
    fanoutSuggestedFiles: ['packages/exf-cli/interactive-tui/index.tsx'],
    branches: [
      {id: 'source_runtime', status: 'ok' as const, elapsedMs: 62, suggestedFileCount: 5},
      {
        id: 'routing_config',
        status: 'failed' as const,
        elapsedMs: 55,
        suggestedFileCount: 0,
        warningCount: 1,
        failureReason: 'timeout',
      },
    ],
    warnings: ['routing_config failed: timeout'],
    rawReport: '<repo_explorer_report>...</repo_explorer_report>',
  };

  it('formats collapsed explorer activity with the important counters', () => {
    expect(formatExplorerActivityLine(activity)).toBe(
      '◇ Explorer · fan-out · 1/2 branches ok · 14 files · 5 used · 7.8KB report · 211ms · cache hit · 1 warning',
    );
  });

  it('formats expanded explorer activity without the raw report body', () => {
    const details = formatExplorerActivityDetails(activity);
    expect(details).toContain('Mode: fan-out');
    expect(details).toContain('Primary candidates');
    expect(details).toContain('- packages/exf-cli/interactive-tui/explorer.ts');
    expect(details).toContain('Fan-out branches');
    expect(details).toContain('⚠ routing_config · 0 files · 55ms · 1 warning · timeout');
    expect(details).not.toContain('Raw report');
    expect(details).not.toContain('<repo_explorer_report>');
  });

  it('validates explorer activity payloads defensively', () => {
    expect(asExplorerActivityView(activity)?.mode).toBe('fanout');
    expect(asExplorerActivityView({mode: 'fanout'})).toBeNull();
    expect(asExplorerActivityView({mode: 'bad', elapsedMs: 1, reportChars: 1, suggestedFileCount: 1})).toBeNull();
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
