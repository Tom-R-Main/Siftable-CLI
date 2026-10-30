import {mkdtemp, mkdir, symlink, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {MAX_REPORT_BYTES, MAX_TESTCASES, parseJUnit, readReport, REPORT_FILE, ReportRefused} from './junitReport.js';

const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n${body}`);
const refused = (bytes: Buffer) => {
  try {
    parseJUnit(bytes);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ReportRefused);
    return (error as ReportRefused).message;
  }
};

describe('JUnit report', () => {
  it('reads node --test output: top-level cases, describe suites, failures, skips and todos', () => {
    // Written by `node --test --test-reporter=junit` (node 22.17.1), local paths replaced.
    const summary = parseJUnit(readFileSync(path.join(__dirname, '../../../test/fixtures/junit/node22.xml')));
    expect(summary.counts).toEqual({collected: 6, passed: 2, failed: 2, skipped: 2});
    expect(summary.testcases.map((testcase) => [testcase.suite.join('/'), testcase.name, testcase.outcome])).toEqual([
      ['', 'adds <1> & &quot;2&quot;', 'passed'],
      ['', 'fails', 'failed'],
      ['', 'skipped one', 'skipped'],
      ['', 'todo one', 'skipped'],
      ['group', 'inner passes', 'passed'],
      ['group', 'inner fails', 'failed'],
    ]);
  });

  it('reads vitest and pytest shapes: nested suites, file attributes, error elements, CDATA output', () => {
    const summary = parseJUnit(xml(`<testsuites name="vitest tests" tests="3">
  <testsuite name="src/add.test.ts" tests="3">
    <properties><property name="seed" value="1"/></properties>
    <testcase classname="src/add.test.ts" name="adds" file="src/add.test.ts" time="0.001"></testcase>
    <testcase classname="src/add.test.ts" name="throws" file="src/add.test.ts"><error message="boom">trace &lt;here&gt;</error></testcase>
    <testcase classname="tests.test_x" name="test_y"><skipped message="later"/><system-out><![CDATA[<not a tag> & raw]]></system-out></testcase>
  </testsuite>
</testsuites>`));
    expect(summary.testcases).toEqual([
      {suite: ['src/add.test.ts'], classname: 'src/add.test.ts', name: 'adds', file: 'src/add.test.ts', outcome: 'passed'},
      {suite: ['src/add.test.ts'], classname: 'src/add.test.ts', name: 'throws', file: 'src/add.test.ts', outcome: 'failed'},
      {suite: ['src/add.test.ts'], classname: 'tests.test_x', name: 'test_y', outcome: 'skipped'},
    ]);
  });

  it('keeps the same name in different suites apart, and refuses a true duplicate', () => {
    const twoSuites = xml('<testsuites><testsuite name="a"><testcase name="x"/></testsuite><testsuite name="b"><testcase name="x"/></testsuite></testsuites>');
    expect(parseJUnit(twoSuites).counts.collected).toBe(2);
    expect(refused(xml('<testsuites><testsuite name="a"><testcase name="x"/><testcase name="x"/></testsuite></testsuites>'))).toMatch(/twice/);
  });

  it('refuses declarations, unknown entities, processing instructions and unknown elements', () => {
    const cases: Array<[string, RegExp]> = [
      ['<!DOCTYPE x [<!ENTITY e "boom">]><testsuites/>', /declarations/],
      ['<testsuites><testsuite name="a"><testcase name="&e;"/></testsuite></testsuites>', /entity/],
      ['<testsuites><testsuite name="a">&xxe;</testsuite></testsuites>', /entity/],
      ['<testsuites><?php echo 1 ?></testsuites>', /processing/],
      ['<testsuites><script/></testsuites>', /not a JUnit element/],
      ['<testsuites><testsuite name="a"><testcase name="x"></testsuite></testsuites>', /does not close/],
      ['<testsuites><testsuite name="a"><testcase name="x"/></testsuite>', /never closed/],
      ['<testsuites/><testsuites/>', /empty|more than one/],
      ['<testcase name="x"/>', /root/],
      ['<testsuites><failure/></testsuites>', /outside a <testcase>/],
      ['<testsuites><testsuite name="a"><testcase/></testsuite></testsuites>', /without a name/],
      ['<testsuites><testsuite name="a"><testcase name="x" name="y"/></testsuite></testsuites>', /repeated/],
      ['<testsuites><testsuite name="a"><testcase name="a<b"/></testsuite></testsuites>', /malformed|unterminated/],
      ['<testsuites><testsuite name="a"><testcase name="&#0;"/></testsuite></testsuites>', /character reference/],
      ['<testsuites><testsuite name="a">', /never closed/],
      ['no xml here', /outside the root/],
      ['', /no root/],
    ];
    for (const [body, pattern] of cases) expect(refused(xml(body)), body).toMatch(pattern);
    expect(refused(Buffer.from([0x3c, 0xff, 0xfe]))).toMatch(/UTF-8/);
  });

  it('refuses reports past the size, testcase and depth caps', () => {
    expect(() => parseJUnit(Buffer.alloc(MAX_REPORT_BYTES + 1, 0x20))).toThrow(/bytes/);
    const many = Array.from({length: MAX_TESTCASES + 1}, (_, i) => `<testcase name="t${i}"/>`).join('');
    expect(refused(xml(`<testsuites><testsuite name="a">${many}</testsuite></testsuites>`))).toMatch(/more than/);
    const deep = `${'<testsuite name="a">'.repeat(70)}${'</testsuite>'.repeat(70)}`;
    expect(refused(xml(`<testsuites>${deep}</testsuites>`))).toMatch(/deeper/);
  });

  it('reads the report file without following a symlink, and names a missing report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'junit-'));
    expect(await readReport(dir)).toMatchObject({ok: false, code: 'report_missing'});
    await writeFile(path.join(dir, 'real.xml'), '<testsuites><testsuite name="a"><testcase name="x"/></testsuite></testsuites>');
    await symlink(path.join(dir, 'real.xml'), path.join(dir, REPORT_FILE));
    expect(await readReport(dir)).toMatchObject({ok: false, code: 'report_invalid'});
    const other = await mkdtemp(path.join(tmpdir(), 'junit-'));
    await mkdir(path.join(other, REPORT_FILE));
    expect(await readReport(other)).toMatchObject({ok: false, code: 'report_invalid'});
    const good = await mkdtemp(path.join(tmpdir(), 'junit-'));
    await writeFile(path.join(good, REPORT_FILE), '<testsuites><testsuite name="a"><testcase name="x"/></testsuite></testsuites>');
    expect(await readReport(good)).toMatchObject({ok: true, summary: {counts: {collected: 1, passed: 1}}});
  });
});
