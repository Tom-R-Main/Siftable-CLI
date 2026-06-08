import {
  EXPLORER_EVAL_FIXTURES,
  EXPLORER_EVAL_PROMPTS,
  candidateFilesFromContext,
  fixtureForPrompt,
  metricFromArtifact,
  scoreCandidateFiles,
  summarizeEvalGate,
} from '../../scripts/repo-explorer-eval-core';

describe('repo explorer eval scoring', () => {
  it('keeps every required baseline prompt in the eval corpus', () => {
    expect(EXPLORER_EVAL_PROMPTS).toEqual(expect.arrayContaining([
      'how does our cli work?',
      'why does Explorer show duplicate blocks?',
      'where is command routing?',
      'where is repo_explorer injected?',
      'what owns native file search?',
    ]));
    expect(EXPLORER_EVAL_FIXTURES.map((fixture) => fixture.prompt)).toEqual(
      expect.arrayContaining(EXPLORER_EVAL_PROMPTS.slice(0, 5)),
    );
  });

  it('extracts candidate paths from compact retrieval artifacts', () => {
    const context = [
      '<repo_explorer_artifact>',
      JSON.stringify({
        files: [
          {path: 'packages/exf-cli/interactive-tui/brain.ts'},
          {path: 'packages/exf-cli/interactive-tui/brain.ts'},
          {path: 'packages/exf-cli/interactive-tui/toolView.ts'},
        ],
        stats: {injectedContextBytes: 3210},
      }),
      '</repo_explorer_artifact>',
    ].join('\n');

    expect(candidateFilesFromContext(context)).toEqual([
      'packages/exf-cli/interactive-tui/brain.ts',
      'packages/exf-cli/interactive-tui/toolView.ts',
    ]);
    expect(metricFromArtifact(context, 'injectedContextBytes')).toBe('3210');
  });

  it('extracts candidate paths from legacy prose reports', () => {
    const context = [
      '<repo_explorer_report>',
      'primary_candidates:',
      '- packages/exf-cli/interactive-tui/brain.ts: literal match',
      '- packages/exf-cli/interactive-tui/explorer.ts: path match',
      'Recommended reads:',
      '- packages/exf-cli/interactive-tui/brain.ts:1-30: inspect injection',
      '</repo_explorer_report>',
    ].join('\n');

    expect(candidateFilesFromContext(context)).toEqual([
      'packages/exf-cli/interactive-tui/brain.ts',
      'packages/exf-cli/interactive-tui/explorer.ts',
    ]);
  });

  it('scores precision, recall, and forbidden top files deterministically', () => {
    const fixture = fixtureForPrompt('how does our cli work?');

    expect(scoreCandidateFiles([
      'packages/exf-cli/package.json',
      'packages/exf-cli/interactive-tui/index.tsx',
      'apps/best-edit/src/App.tsx',
      'packages/exf-cli/src/commands/work.ts',
    ], fixture)).toEqual({
      precision: 0.75,
      recall: 1,
      forbiddenTopFileHit: true,
    });
  });

  it('fails malformed artifact contexts closed instead of inventing candidates', () => {
    expect(candidateFilesFromContext('<repo_explorer_artifact>{bad json}</repo_explorer_artifact>')).toEqual([]);
    expect(metricFromArtifact('<repo_explorer_artifact>{bad json}</repo_explorer_artifact>', 'injectedContextBytes')).toBe('');
  });

  it('summarizes the eval gate with precision weighted above recall', () => {
    expect(summarizeEvalGate([
      {
        prompt: 'how does our cli work?',
        mode: 'deterministic',
        filePrecision: 0.5,
        fileRecall: 1,
        forbiddenTopFileHit: false,
        injectedContextBytes: 6000,
      },
      {
        prompt: 'how does our cli work?',
        mode: 'fast-context',
        filePrecision: 0.75,
        fileRecall: 0.67,
        forbiddenTopFileHit: false,
        injectedContextBytes: 3000,
      },
    ])).toMatchObject({
      deterministicScore: 0.65,
      fastContextScore: 0.726,
      passed: true,
      errors: [],
    });
  });

  it('fails the eval gate on forbidden files or oversized context', () => {
    const summary = summarizeEvalGate([
      {
        prompt: 'how does our cli work?',
        mode: 'deterministic',
        filePrecision: 0.8,
        fileRecall: 1,
        forbiddenTopFileHit: false,
        injectedContextBytes: 6000,
      },
      {
        prompt: 'how does our cli work?',
        mode: 'fast-context',
        filePrecision: 0.5,
        fileRecall: 1,
        forbiddenTopFileHit: true,
        injectedContextBytes: 9000,
      },
    ]);

    expect(summary.passed).toBe(false);
    expect(summary.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('did not beat'),
      expect.stringContaining('forbidden'),
      expect.stringContaining('context cap'),
    ]));
  });
});
