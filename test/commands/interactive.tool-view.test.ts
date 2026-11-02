import {
  asExplorerActivityView,
  explorerToolCallText,
  formatExplorerActivityDetails,
  formatExplorerActivityLine,
  isExplorerToolName,
  toolArgPreview,
  toolCallLabel,
  clipOutput,
  summarizeToolOutput,
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
      '◇ Explorer · checking repo in parallel · read-only parallel scouts',
    );
  });
});

describe('toolView — explorer activity', () => {
  const activity = {
    mode: 'fanout' as const,
    evidenceQuality: 'medium' as const,
    cacheHit: true,
    elapsedMs: 211,
    reportChars: 7980,
    suggestedFileCount: 14,
    usedSuggestedFileCount: 5,
    primaryCandidates: [
      'packages/exf-cli/interactive-tui/explorer.ts',
      'packages/exf-cli/interactive-tui/brain.ts',
    ],
    assignedRoles: ['source_runtime', 'tests', 'ui_surface'],
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
      '◇ Explorer · checked repo · source_runtime/tests/ui_surface · 1/2 scouts · 14 files · 211ms · 1 warning',
    );
  });

  it('does not label all-failed fanout as a successful repo check', () => {
    expect(formatExplorerActivityLine({
      ...activity,
      evidenceQuality: 'low',
      suggestedFileCount: 8,
      branches: [
        {id: 'routing_config', status: 'failed', elapsedMs: 3155, suggestedFileCount: 0, warningCount: 1},
        {id: 'tests', status: 'failed', elapsedMs: 5948, suggestedFileCount: 0, warningCount: 1},
      ],
      warnings: ['routing_config failed: budget', 'tests failed: budget'],
    })).toBe(
      '◇ Explorer · fallback only · source_runtime/tests/ui_surface · 0/2 scouts · 8 files · 211ms · 2 warnings',
    );
  });

  it('labels weak deterministic maps as low confidence', () => {
    expect(formatExplorerActivityLine({
      mode: 'deterministic',
      evidenceQuality: 'low',
      elapsedMs: 31,
      reportChars: 1200,
      suggestedFileCount: 0,
      primaryCandidates: [],
      scoutSuggestedFiles: [],
      fanoutSuggestedFiles: [],
      warnings: [],
    })).toBe('◇ Explorer · low-confidence map · 0 files · 31ms');
  });

  it('formats expanded explorer activity without the raw report body', () => {
    const details = formatExplorerActivityDetails(activity);
    expect(details).toContain('Mode: fan-out');
    expect(details).toContain('Assigned scouts: source_runtime, tests, ui_surface');
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


describe('compact semantic tool output', () => {
  const summarize = (name: string, value: unknown, args?: Record<string, unknown>) =>
    summarizeToolOutput(name, JSON.stringify(value), {args, width: 100});

  it('shows a loaded skill without its prompt or serialized envelope', () => {
    const raw = JSON.stringify({success: true, data: {name: 'work'}, message: 'Sensitive long skill body'});
    expect(summarizeToolOutput('skill', raw)).toBe('Loaded skill: work');
    expect(JSON.parse(raw).message).toBe('Sensitive long skill body');
  });

  it('summarizes tasks by title and state while omitting unrelated fields', () => {
    expect(summarize('exf_tasks_list', {success: true, data: {total: 9, tasks: [
      {title: 'Fix model picker', status: 'running', userId: 'opaque-id', description: 'long description'},
      {title: 'Improve summaries', status: 'queued'},
    ]}})).toBe('2 of 9 tasks returned\nFix model picker · running\nImprove summaries · queued');
  });

  it('shows requested file ranges without file contents', () => {
    expect(summarize('batch_read_files', {success: true, data: {files: [
      {path: 'src/brain.ts', content: 'do not display the source body'},
    ]}}, {files: [{path: 'src/brain.ts', startLine: 10, endLine: 20}]}))
      .toBe('1 file read\nsrc/brain.ts:10-20');
  });

  it('keeps partial zero-result searches distinguishable from complete ones', () => {
    const result = summarize('search_local_files', {success: true, data: {matches: [], stats: {
      searchedFiles: 161, capped: true, scan: {status: 'partial', reasons: ['maxFiles']},
    }}});
    expect(result).toBe('0 matches in 161 files · partial search · capped · maxFiles');
    expect(summarize('search_local_files', {data: {matches: [], stats: {searchedFiles: 9}}}))
      .toBe('0 matches in 9 files');
  });

  it('prioritizes errors even for tools that usually get a success summary', () => {
    expect(summarize('skill', {success: false, error: 'Skill not found'})).toBe('Failed: Skill not found');
    expect(summarize('batch_read_files', {error: {message: 'Permission denied'}})).toBe('Failed: Permission denied');
  });

  it('surfaces file failures before the first successful file previews', () => {
    const files = ['a', 'b', 'c'].map((path) => ({path, content: 'body'}));
    const result = summarize('batch_read_files', {data: {files: [...files, {path: 'd', error: 'denied'}]}});
    expect(result.split('\n')[0]).toBe('3 files read · 1 failed');
    expect(result).toContain('d · Failed: denied');
  });

  it('retains bounded command JSON as text, even when it resembles an envelope', () => {
    const raw = JSON.stringify({success: false, name: 'package-name'});
    expect(summarizeToolOutput('shell', raw, {format: 'text'})).toBe(raw);
    expect(summarizeToolOutput('shell', raw, {format: 'text', width: 24})).toContain('…');
  });

  it('keeps a failing shell exit and stderr before stdout', () => {
    expect(summarize('shell', {data: {exit_code: 1, stdout: 'verbose\noutput', stderr: 'failed'}})
      .split('\n').slice(0, 2)).toEqual(['Exit 1', 'failed']);
  });

  it('keeps truncated file and batch reads visible in the first row', () => {
    expect(summarize('read_file', {data: {path: 'large.ts', content: 'partial', truncated: true}})
      .split('\n')[0]).toBe('Partial read · truncated · 1 file read');
    expect(summarize('batch_read_files', {data: {files: [
      {path: 'a'}, {path: 'b'}, {path: 'c'}, {path: 'd', truncated: true},
    ]}}).split('\n')[0]).toBe('Partial read · truncated · 4 files read');
    expect(summarize('batch_read_files', {data: {files: [{path: 'a'}], truncated: true}})
      .split('\n')[0]).toBe('Partial read · truncated · 1 file read');
  });

  it('does not fabricate zero matches for unrelated search response schemas', () => {
    expect(summarize('web_search', {data: {results: [{title: 'Found result'}]}}))
      .toBe('Structured result received');
  });

  it('does not dump unknown structured payloads or incomplete JSON', () => {
    expect(summarize('custom', {data: {internalId: 'opaque', nested: {large: 'content'}}}))
      .toBe('Structured result received');
    expect(summarizeToolOutput('custom', '{"data":{"large":"truncated'))
      .toBe('Structured output truncated (preview unavailable)');
  });

  it('preserves plain logs that start with JSON-like punctuation', () => {
    for (const raw of ['{"status": starting', '[{"log"} failed']) {
      expect(summarizeToolOutput('custom', raw)).toBe(raw);
    }
  });

  it('bounds long logical lines by terminal columns and shows omitted lines', () => {
    const output = summarizeToolOutput('shell', 'a'.repeat(5000) + '\nsecond\nthird\nfourth', {width: 24});
    expect(output.split('\n')).toHaveLength(4);
    expect(output).toContain('… +1 more lines');
    expect(output.split('\n').every((line) => line.length <= 24)).toBe(true);
    expect(output).not.toContain('fourth');
  });

  it('removes terminal control sequences and budgets wide characters', () => {
    expect(summarizeToolOutput('shell', '\u001b[31mhello\u001b[0m')).toBe('hello');
    expect(summarizeToolOutput('shell', '界'.repeat(100), {width: 10})).toBe('界界界界…');
  });
});
