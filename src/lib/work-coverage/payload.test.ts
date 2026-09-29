import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {GitReader, PlanStep} from './bind.js';
import {BOUNDS, boundAssertion, buildCoverageShadowPayload, caseId, MAX_CANDIDATES, selectedByNameFilters} from './payload.js';

const COMMIT = 'a'.repeat(40);

function stubGit(files: Record<string, string>): GitReader {
  return {
    resolveCommit: async (ref) => (ref === 'HEAD' || /^[0-9a-f]{40}$/.test(ref) ? COMMIT : null),
    listFiles: async () => Object.keys(files),
    show: async (_commit, path) => files[path] ?? '',
  };
}

const step = (command: string): PlanStep => ({kind: 'shell', title: 'tests', spec: {command}});

describe('caseId', () => {
  it('is the first 10 hex of sha256(commit:file:line:title)', () => {
    const expected = createHash('sha256').update(`${COMMIT}:a/b.test.ts:7:does it`).digest('hex').slice(0, 10);
    expect(caseId(COMMIT, 'a/b.test.ts', 7, 'does it')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe('boundAssertion', () => {
  it('keeps short assertions and fits marked ones within 400 characters', () => {
    expect(boundAssertion('expect(a).toBe(1)')).toBe('expect(a).toBe(1)');
    const marked = `${'x'.repeat(400)} …`;
    const bounded = boundAssertion(marked);
    expect(bounded).toHaveLength(400);
    expect(bounded.endsWith(' …')).toBe(true);
  });
});

describe('buildCoverageShadowPayload', () => {
  it('builds the contract payload and leaves skipped cases out', async () => {
    const src = [
      "describe('Model Connection routes', () => {",
      "  it('never echoes the credential', async () => {",
      '    expect(serialized).not.toContain(CREDENTIAL);',
      '  });',
      "  it.skip('parked', () => { expect(1).toBe(1); });",
      '});',
      '',
    ].join('\n');
    const git = stubGit({'exf-app/src/routes/modelConnections.test.ts': src, 'README.md': '# x'});
    const built = await buildCoverageShadowPayload({
      commit: COMMIT, planVersion: 3, git,
      steps: [
        step('npm exec -- nx run @execufunction/exf-app:test:unit -- modelConnections'),
        step('npm exec -- nx run @execufunction/web:test'),
      ],
    });
    expect(built.skippedCases).toBe(1);
    expect(built.tooBroad).toBe(false);
    expect(built.payload).toEqual({
      schemaVersion: 1,
      commit: COMMIT,
      planVersion: 3,
      candidatesComplete: false,
      incompleteReasons: ['whole_target: npm exec -- nx run @execufunction/web:test'],
      candidates: [{
        caseId: caseId(COMMIT, 'exf-app/src/routes/modelConnections.test.ts', 2, 'never echoes the credential'),
        file: 'exf-app/src/routes/modelConnections.test.ts',
        line: 2,
        describePath: ['Model Connection routes'],
        title: 'never echoes the credential',
        flags: [],
        gates: [],
        assertions: ['expect(serialized).not.toContain(CREDENTIAL)'],
        body: "it('never echoes the credential', async () => {\n    expect(serialized).not.toContain(CREDENTIAL);\n  })",
      }],
    });
  });

  it('bounds assertions, their length and the body', async () => {
    const asserts = Array.from({length: 15}, (_, i) => `expect(v${i}).toEqual('${'z'.repeat(600)}');`).join('\n');
    const src = `it('bounded', () => {\n${asserts}\n});\n`;
    const built = await buildCoverageShadowPayload({
      commit: COMMIT, planVersion: 1, git: stubGit({'pkg/a.test.ts': src}), steps: [step('npx jest pkg/a.test.ts')],
    });
    const [c] = built.payload.candidates;
    expect(c.assertions).toHaveLength(12);
    for (const a of c.assertions) expect(a.length).toBeLessThanOrEqual(400);
    expect(c.body.length).toBe(4000);
    expect(built.payload.candidatesComplete).toBe(true);
  });

  it('reports too_broad above 150 candidates', async () => {
    const cases = Array.from({length: MAX_CANDIDATES + 1}, (_, i) => `it('case ${i}', () => { expect(${i}).toBe(${i}); });`);
    const built = await buildCoverageShadowPayload({
      commit: COMMIT, planVersion: 1, git: stubGit({'pkg/a.test.ts': cases.join('\n')}), steps: [step('npx jest pkg/a.test.ts')],
    });
    expect(built.payload.candidates).toHaveLength(151);
    expect(built.tooBroad).toBe(true);
  });

  it('is exactly at the cap with 150 candidates', async () => {
    const cases = Array.from({length: MAX_CANDIDATES}, (_, i) => `it('case ${i}', () => { expect(${i}).toBe(${i}); });`);
    const built = await buildCoverageShadowPayload({
      commit: COMMIT, planVersion: 1, git: stubGit({'pkg/a.test.ts': cases.join('\n')}), steps: [step('npx jest pkg/a.test.ts')],
    });
    expect(built.tooBroad).toBe(false);
  });
});

describe('test-name filters', () => {
  it('matches the full name as a regular expression, keeps unknowable titles, and treats no filter as run-all', () => {
    expect(selectedByNameFilters('share dialog sends email', 'sends email', [['sends']])).toBe(true);
    expect(selectedByNameFilters('share dialog revokes link', 'revokes link', [['sends']])).toBe(false);
    expect(selectedByNameFilters('share handles %s', 'handles %s', [['sends']])).toBe(true);
    expect(selectedByNameFilters('x', 'x', [['nomatch'], []])).toBe(true);
    expect(selectedByNameFilters('a (b', 'a (b', [['a (b']])).toBe(true);
    expect(selectedByNameFilters('anything', 'anything', [])).toBe(true);
    expect(selectedByNameFilters('<dynamic> sends', 'sends', [['nomatch']], ['<dynamic>'])).toBe(true);
    expect(selectedByNameFilters('suite %s sends', 'sends', [['nomatch']], ['suite %s'])).toBe(true);
  });

  it('leaves out cases the step would not run', async () => {
    const src = "describe('share', () => {\n  it('sends email', () => { expect(a).toBe(1); });\n  it('revokes link', () => { expect(b).toBe(1); });\n});\n";
    const built = await buildCoverageShadowPayload({
      commit: COMMIT, planVersion: 1, git: stubGit({'exf-app/src/share.test.ts': src}),
      steps: [step("npm test --workspace exf-app -- share -t 'sends'")],
    });
    expect(built.payload.candidates.map((c) => c.title)).toEqual(['sends email']);
    expect(built.filteredCases).toBe(1);
  });
});

describe('server bounds', () => {
  it('clips titles, describe paths, gates and incomplete reasons to the API schema', async () => {
    const long = 'y'.repeat(1500);
    const src = `describe('${'d'.repeat(700)}', () => {\n  it('${long}', () => { expect(a).toBe(1); });\n});\n`;
    const steps = [step('npm test --workspace exf-app -- share'), ...Array.from({length: 60}, (_, i) => step(`npm run build --workspace exf-app-${i} && nx run-many -t test`))];
    const built = await buildCoverageShadowPayload({commit: COMMIT, planVersion: 1, git: stubGit({'exf-app/src/share.test.ts': src}), steps});
    const c = built.payload.candidates[0];
    expect(c.title.length).toBeLessThanOrEqual(BOUNDS.title);
    expect(c.describePath[0].length).toBeLessThanOrEqual(BOUNDS.describeChars);
    expect(built.payload.incompleteReasons.length).toBeLessThanOrEqual(BOUNDS.reasons);
    expect(built.payload.candidatesComplete).toBe(false);
  });
});

describe('exclusive and path-filtered selection', () => {
  it('sends only the .only cases of a file that has them', async () => {
    const src = "it.only('focused', () => { expect(1).toBe(1); });\nit('sibling', () => { expect(2).toBe(2); });\n";
    const built = await buildCoverageShadowPayload({commit: COMMIT, planVersion: 1, git: stubGit({'exf-app/src/share.test.ts': src}),
      steps: [step('npm test --workspace exf-app -- share')]});
    expect(built.payload.candidates.map((c) => c.title)).toEqual(['focused']);
  });

  it('reads --testPathPattern (separate and = forms) as file patterns', async () => {
    const src = "it('sends', () => { expect(1).toBe(1); });\n";
    for (const cmd of ['npx jest --testPathPattern=share', 'npx jest --testPathPattern share']) {
      const built = await buildCoverageShadowPayload({commit: COMMIT, planVersion: 1, git: stubGit({'exf-app/src/share.test.ts': src}), steps: [step(cmd)]});
      expect(built.payload.candidates.map((c) => c.title)).toEqual(['sends']);
    }
  });
});

