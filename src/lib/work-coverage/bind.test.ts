import {describe, expect, it} from 'vitest';
import {bindPlan, classify, patterns, projectDir, resolve, shlexSplit, type PlanStep} from './bind.js';

const shell = (command: string): PlanStep => ({kind: 'shell', title: 'step', spec: {command}});

const FILES = [
  'exf-app/src/routes/modelConnections.test.ts',
  'exf-app/src/routes/modelConnections.vitest.test.ts',
  'exf-app/src/services/billing.test.ts',
  'exf-app/web/src/views/Home.test.tsx',
  'exf-app/web/src/views/Home.vitest.tsx',
  'packages/exf-cli/src/commands/work/verify.test.ts',
  'packages/shared/src/format.test.ts',
  'README.md',
];

describe('shlexSplit', () => {
  it('splits like POSIX shlex', () => {
    expect(shlexSplit(`npx jest -t 'accepts a "credential"' "a b\\"c" x\\ y ''`)).toEqual([
      'npx', 'jest', '-t', 'accepts a "credential"', 'a b"c', 'x y', '',
    ]);
  });

  it('throws on an unclosed quote', () => {
    expect(() => shlexSplit("npx jest 'open")).toThrow('No closing quotation');
  });
});

describe('classify', () => {
  it('classifies external, static, unknown and serialised command lists', () => {
    expect(classify({kind: 'external', title: 'Product review'})).toEqual({class: 'external_text'});
    expect(classify(shell('npm exec -- nx run @execufunction/web:typecheck'))).toEqual({class: 'static'});
    expect(classify(shell('git diff --check'))).toEqual({class: 'static'});
    expect(classify(shell('curl https://siftable.io/readyz'))).toEqual({class: 'unknown'});
    expect(classify(shell('["npm test", "npm run lint"]')))
      .toEqual({class: 'unknown', why: 'command list serialised as one step'});
  });

  it('classifies a non-JS runner', () => {
    expect(classify(shell('cargo test --workspace')).class).toBe('non_js_test');
    expect(classify(shell('go test ./...')).class).toBe('non_js_test');
    // pytest alone never matches the JS runner pattern, so it is not a test step at all.
    expect(classify(shell('python3 -m pytest scripts/test_x.py'))).toEqual({class: 'unknown'});
  });

  it('classifies whole targets', () => {
    expect(classify(shell('npm exec -- nx run @execufunction/web:test')))
      .toEqual({class: 'whole_target', projectDir: 'exf-app/web', nameFilters: []});
    expect(classify(shell('npm exec -- nx run-many -t test'))).toEqual({class: 'whole_target', projectDir: null});
    expect(classify(shell('npm exec -- nx affected -t test:vitest')).class).toBe('whole_target');
  });

  it('classifies a patterned Jest run with a name filter and project directory', () => {
    expect(classify(shell("npm exec -- nx run @execufunction/exf-app:test:unit -- modelConnections -t 'never echoes'"))).toEqual({
      class: 'patterned_test', projectDir: 'exf-app', patterns: ['modelConnections'], nameFilters: ['never echoes'],
      runner: 'jest',
    });
  });

  it('classifies a patterned Vitest run from --workspace and --prefix', () => {
    expect(classify(shell('npm run test:vitest --workspace @execufunction/web -- src/views/Home.vitest.tsx'))).toMatchObject({
      class: 'patterned_test', projectDir: 'exf-app/web', patterns: ['src/views/Home.vitest.tsx'], runner: 'vitest',
    });
    expect(classify(shell('npx --prefix packages/exf-cli vitest run src/commands/work/verify.test.ts'))).toMatchObject({
      class: 'patterned_test', projectDir: 'packages/exf-cli', patterns: ['src/commands/work/verify.test.ts'], runner: 'vitest',
    });
  });

  it('reads the project directory from a bare project name after test/run', () => {
    expect(projectDir(['npx', 'nx', 'test', '@execufunction/shared'], null)).toBe('packages/shared');
    expect(projectDir(['npx', 'nx', 'run', '@unknown/pkg:test'], 'x')).toBeNull();
    expect(projectDir(['npx', 'jest'], 'fallback')).toBe('fallback');
  });

  it('collects positional patterns only after the runner', () => {
    expect(patterns(['npx', 'jest', '--config', 'jest.config.js', 'billing', '--runInBand', 'a=b'])).toEqual({
      patterns: ['billing'], names: [],
    });
  });
});

describe('resolve', () => {
  it('resolves paths directly and under the project directory', () => {
    expect(resolve(['src/routes/modelConnections.test.ts'], 'exf-app', FILES))
      .toEqual(['exf-app/src/routes/modelConnections.test.ts']);
    expect(resolve(['packages/shared/src/format.test.ts'], null, FILES)).toEqual(['packages/shared/src/format.test.ts']);
    expect(resolve(['src/missing.test.ts'], 'exf-app', FILES)).toEqual([]);
  });

  it('treats non-path patterns as regular expressions scoped to the project directory', () => {
    expect(resolve(['modelConnections'], 'exf-app', FILES, 'other')).toEqual([
      'exf-app/src/routes/modelConnections.test.ts',
      'exf-app/src/routes/modelConnections.vitest.test.ts',
    ]);
    expect(resolve(['(billing|format)'], null, FILES)).toEqual([
      'exf-app/src/services/billing.test.ts',
      'packages/shared/src/format.test.ts',
    ]);
    expect(resolve(['[unclosed'], null, FILES)).toEqual([]);
  });

  it('filters by runner-specific suffix', () => {
    expect(resolve(['modelConnections'], 'exf-app', FILES, 'jest')).toEqual(['exf-app/src/routes/modelConnections.test.ts']);
    // Vitest projects here run *.test.ts as well as *.vitest.ts, so a Vitest step keeps both.
    expect(resolve(['modelConnections'], 'exf-app', FILES, 'vitest')).toEqual([
      'exf-app/src/routes/modelConnections.test.ts',
      'exf-app/src/routes/modelConnections.vitest.test.ts',
    ]);
    expect(resolve(['billing'], 'exf-app', FILES, 'vitest')).toEqual(['exf-app/src/services/billing.test.ts']);
    expect(resolve(['Home'], 'exf-app/web', FILES, 'jest')).toEqual(['exf-app/web/src/views/Home.test.tsx']);
  });
});

describe('bindPlan', () => {
  it('unions resolved files and lists completeness reasons', () => {
    const steps: PlanStep[] = [
      {id: 's1', key: 'unit', ...shell('npm exec -- nx run @execufunction/exf-app:test:unit -- modelConnections')},
      {id: 's2', key: 'web', ...shell('npm exec -- nx run @execufunction/web:test')},
      {id: 's3', key: 'gone', ...shell('npx jest src/nothing-here.test.ts')},
      {id: 's4', key: 'types', ...shell('npm exec -- nx run-many -t typecheck')},
      {id: 's5', key: 'review', kind: 'external', title: 'Human review'},
      {id: 's6', key: 'zig', ...shell('zig build test')},
      {id: 's7', key: 'curl', ...shell('curl -f http://127.0.0.1:8080/readyz')},
    ];
    const b = bindPlan(steps, FILES);
    expect(b.testFiles).toEqual(['exf-app/src/routes/modelConnections.test.ts']);
    expect(b.candidatesComplete).toBe(false);
    expect(b.incompleteReasons).toEqual([
      'whole_target: npm exec -- nx run @execufunction/web:test',
      'pattern resolved to no file: npx jest src/nothing-here.test.ts',
      'non_js_test: zig build test',
      'unknown: curl -f http://127.0.0.1:8080/readyz',
    ]);
    expect(b.steps[0]).toMatchObject({stepId: 's1', class: 'patterned_test', resolved: b.testFiles});
  });

  it('is complete when every step is static, external or resolved', () => {
    const b = bindPlan([
      shell('npx vitest run src/commands/work/verify.test.ts --prefix packages/exf-cli'),
      shell('npm run lint'),
      {kind: 'external', title: 'Screenshot'},
    ], FILES);
    expect(b.candidatesComplete).toBe(true);
    expect(b.incompleteReasons).toEqual([]);
  });

  it('truncates the command in a reason to 120 characters', () => {
    const long = `npm exec -- nx run @execufunction/web:test ${'x'.repeat(200)}`;
    const b = bindPlan([shell(long)], FILES);
    expect(b.incompleteReasons[0]).toBe(`pattern resolved to no file: ${long.slice(0, 120)}`);
  });
});

describe('test-name filter forms', () => {
  it('reads separate and equals forms of -t, --testNamePattern and --grep', () => {
    expect(patterns(shlexSplit("npx jest -- share -t 'sends email'")).names).toEqual(['sends email']);
    expect(patterns(shlexSplit('npx jest -- share --testNamePattern=sends')).names).toEqual(['sends']);
    expect(patterns(shlexSplit('npx vitest run share -t=revokes')).names).toEqual(['revokes']);
    expect(patterns(shlexSplit('npx playwright test journey --grep=@smoke')).names).toEqual(['@smoke']);
    expect(patterns(shlexSplit('npx jest -- share --testNamePattern=sends')).patterns).toEqual(['share']);
  });
});
