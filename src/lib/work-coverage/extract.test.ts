// Port of the 17 fixtures in docs/research/jev-work-review-audit/scripts/test_extract_cases.py,
// plus body-extraction cases for jev_v2_r2.py `body_of`.
import {describe, expect, it} from 'vitest';
import {BODY_CHARS, bodyOf, extract, type ExtractedCase} from './extract.js';

function byTitle(cases: ExtractedCase[]): Record<string, ExtractedCase> {
  return Object.fromEntries(cases.map((c) => [c.title, c]));
}

describe('comments', () => {
  it('does not offer line and block comments as cases', () => {
    const src = `
describe('suite', () => {
  // it('commented line test', () => { expect(a).toBe(1); });
  /*
  it('commented block test', () => { expect(b).toBe(2); });
  */
  it('real test', () => { expect(c).toBe(3); });
});
`;
    expect(extract(src).map((c) => c.title)).toEqual(['real test']);
  });

  it('keeps comment markers inside strings', () => {
    const cases = extract("it('has // in title', () => { expect(url).toBe('http://x'); });");
    expect(cases[0].title).toBe('has // in title');
    expect(cases[0].assertions).toEqual(["expect(url).toBe('http://x')"]);
  });

  it('keeps line numbers through masking', () => {
    expect(extract("/* a\nb\nc */\nit('x', () => { expect(1).toBe(1); });")[0].line).toBe(4);
  });
});

describe('skips', () => {
  it('propagates describe.skip to children', () => {
    const src = `
describe.skip('off', () => {
  describe('inner', () => { it('child', () => { expect(a).toBe(1); }); });
});
describe('on', () => { it('live', () => { expect(b).toBe(1); }); });
`;
    const c = byTitle(extract(src));
    expect(c.child.flags).toContain('skipped');
    expect(c.live.flags).not.toContain('skipped');
  });

  it('marks it.skip and it.todo as skipped', () => {
    const src = "it.skip('s', () => { expect(1).toBe(1); });\nit.todo('t');\nit('ok', () => { expect(1).toBe(1); });";
    const c = byTitle(extract(src));
    expect(c.s.flags).toContain('skipped');
    expect(c.t.flags).toContain('skipped');
    expect(c.ok.flags).not.toContain('skipped');
  });
});

describe('gates', () => {
  it('flags an alias gate', () => {
    const src = `
const describePg = process.env.PG_INTEGRATION === '1' ? describe : describe.skip;
describePg('pg', () => { it('writes row', () => { expect(rows).toHaveLength(1); }); });
`;
    const c = extract(src)[0];
    expect(c.flags).toContain('conditional_gate');
    expect(c.flags).not.toContain('skipped');
    expect(c.gates[0]).toContain('PG_INTEGRATION');
    expect(c.describePath).toEqual(['pg']);
  });

  it('flags an inline ternary gate', () => {
    const c = extract("(process.env.RUN ? describe : describe.skip)('pg', () => { it('x', () => { expect(1).toBe(1); }); });")[0];
    expect(c.flags).toContain('conditional_gate');
    expect(c.gates[0]).toContain('process.env.RUN');
  });

  it('flags vitest skipIf', () => {
    const c = extract("describe.skipIf(!process.env.PG)('pg', () => { it('x', () => { expect(1).toBe(1); }); });")[0];
    expect(c.flags).toContain('conditional_gate');
    expect(c.gates).toContain('skip if !process.env.PG');
  });

  it('flags a Playwright conditional skip inside a describe', () => {
    const src = `
test.describe('journey', () => {
  test.beforeEach(async ({}, testInfo) => { test.skip(testInfo.project.name !== 'chromium', 'desktop only'); });
  test('creates a map', async ({ page }) => { await expect(page.getByText('Map')).toBeVisible(); });
});
`;
    const c = extract(src);
    expect(c).toHaveLength(1);
    expect(c[0].flags).toContain('conditional_gate');
    expect(c[0].gates[0]).toContain('testInfo.project.name');
  });

  it('nests Playwright describe blocks and propagates test.describe.skip', () => {
    const src = `
test.describe('outer', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(1000);
  test('inner case', async () => { await expect(a).toBeVisible(); });
});
test.describe.skip('off', () => { test('dead', async () => { expect(1).toBe(1); }); });
`;
    const c = byTitle(extract(src));
    expect(new Set(Object.keys(c))).toEqual(new Set(['inner case', 'dead']));
    expect(c['inner case'].describePath).toEqual(['outer']);
    expect(c.dead.flags).toContain('skipped');
  });

  it('gives an ungated case no gate', () => {
    const c = extract("it('plain', () => { expect(1).toBe(1); });")[0];
    expect(c.gates).toEqual([]);
    expect(c.flags).not.toContain('conditional_gate');
  });
});

describe('assertions', () => {
  it('captures a multiline assertion whole', () => {
    const src = `
it('sends', () => {
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'a@b.c',
      locale: 'fr',
    }),
  );
});
`;
    const a = extract(src)[0].assertions;
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("to: 'a@b.c'");
    expect(a[0]).toContain("locale: 'fr'");
    expect(a[0].startsWith('expect(send).toHaveBeenCalledWith(')).toBe(true);
  });

  it('follows matcher chains with not and resolves', () => {
    const src = "it('x', async () => { await expect(p).resolves.not.toContain('secret'); expect(a).not.toMatch(/k/); });";
    expect(extract(src)[0].assertions).toEqual([
      "expect(p).resolves.not.toContain('secret')",
      'expect(a).not.toMatch(/k/)',
    ]);
  });

  it('does not count nested expect helpers as separate assertions', () => {
    expect(extract("it('x', () => { expect(fn).toHaveBeenCalledWith(expect.any(String)); });")[0].assertions).toHaveLength(1);
  });

  it('flags a case with no assertions', () => {
    expect(extract("it('renders', () => { render(<A/>); });")[0].flags).toContain('no_assertions');
  });
});

describe('titles', () => {
  it('flags each tables and dynamic titles', () => {
    const src = "it.each([[1],[2]])('handles %s', (n) => { expect(n).toBeTruthy(); });\nit(`id ${x}`, () => { expect(1).toBe(1); });";
    const cases = extract(src);
    expect(cases[0].flags).toContain('parameterised');
    expect(cases[1].flags).toContain('dynamic_title');
  });

  it('does not treat property access as a test', () => {
    const src = "obj.it('no', () => {});\nsubmit('no');\nit('yes', () => { expect(1).toBe(1); });";
    expect(extract(src).map((c) => c.title)).toEqual(['yes']);
  });
});

describe('extractor bounds and body', () => {
  it('keeps at most twelve assertions and bounds each one', () => {
    const many = Array.from({length: 14}, (_, i) => `expect(v${i}).toBe(${i});`).join(' ');
    const long = `expect(x).toEqual('${'a'.repeat(500)}');`;
    const [c] = extract(`it('many', () => { ${long} ${many} });`);
    expect(c.assertions).toHaveLength(12);
    expect(c.assertionsTruncated).toBe(true);
    expect(c.assertions[0]).toHaveLength(402);
    expect(c.assertions[0].endsWith(' …')).toBe(true);
  });

  it('returns the masked body from the case line to its closing parenthesis', () => {
    const src = "describe('s', () => {\n  // note\n  it('x', () => {\n    expect(1).toBe(1); // trailing\n  });\n});\n";
    const [c] = extract(src);
    expect(c.line).toBe(3);
    expect(bodyOf(src, c.line)).toBe("  it('x', () => {\n    expect(1).toBe(1);            \n  })");
  });

  it('caps the body', () => {
    const src = `it('big', () => { const s = '${'b'.repeat(6000)}'; expect(s).toBeTruthy(); });`;
    expect(bodyOf(src, 1)).toHaveLength(BODY_CHARS);
  });
});
