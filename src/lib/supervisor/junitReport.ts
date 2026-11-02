/**
 * Reads a test run's JUnit XML report (first-run U3, verification contract
 * rev 2, D1). The report is written by repository code, so it is parsed here,
 * in a helper container with no network that sees the report read-only, never
 * in the supervisor. Run with the image's node from a read-only mount.
 *
 * Only the elements JUnit reporters emit (node --test, vitest, pytest) are
 * accepted. A DOCTYPE, an entity other than the five XML ones and numeric
 * references, a processing instruction after the declaration, an unknown
 * element, a mismatched tag, two testcases with the same identity, or more
 * than the caps refuse the whole report: nothing partial is returned.
 *
 * Output is one JSON line on stdout. Exit 0 means the report was read.
 * Self-contained: Node built-ins only.
 */
import {promises as fs} from 'node:fs';

export const REPORT_FILE = 'junit.xml';
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_TESTCASES = 50_000;
const MAX_DEPTH = 64;

const ELEMENTS = new Set(['testsuites', 'testsuite', 'testcase', 'failure', 'error', 'skipped', 'system-out', 'system-err',
  'properties', 'property']);
const ENTITIES: Record<string, string> = {lt: '<', gt: '>', amp: '&', quot: '"', apos: '\''};

export type TestOutcome = 'passed' | 'failed' | 'skipped';
export interface TestCase {
  /** The names of the enclosing <testsuite> elements, outermost first: node --test reports describe blocks this way. */
  suite: string[];
  classname: string;
  name: string;
  file?: string;
  outcome: TestOutcome;
}
export interface ReportSummary {
  testcases: TestCase[];
  counts: {collected: number; passed: number; failed: number; skipped: number};
}

export class ReportRefused extends Error {
  constructor(readonly code: 'report_too_large' | 'report_invalid', message: string) {
    super(message);
  }
}

const invalid = (message: string) => new ReportRefused('report_invalid', message);

/** Decodes the five XML entities and numeric references; any other `&` is refused. */
export function decodeText(raw: string): string {
  return raw.replace(/&([^;&\s]{0,10});?/g, (match, ref: string) => {
    if (!match.endsWith(';')) throw invalid(`unterminated reference ${match}`);
    if (ref in ENTITIES) return ENTITIES[ref];
    const numeric = /^#x([0-9a-fA-F]{1,6})$/.exec(ref) ?? /^#([0-9]{1,7})$/.exec(ref);
    if (numeric) {
      const code = Number.parseInt(numeric[1], ref.startsWith('#x') ? 16 : 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw invalid(`bad character reference ${match}`);
      return String.fromCodePoint(code);
    }
    throw invalid(`entity ${match} is not allowed`);
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw invalid(`malformed attributes: ${source.slice(index, index + 40)}`);
    if (attributes.has(match[1])) throw invalid(`attribute ${match[1]} repeated`);
    attributes.set(match[1], decodeText(match[2] ?? match[3] ?? ''));
    index = pattern.lastIndex;
  }
  return attributes;
}

interface Open {
  name: string;
  suiteName?: string;
  testcase?: {suite: string[]; classname: string; name: string; file?: string; failed: boolean; skipped: boolean};
}

/** The end of the tag that starts at `lt`, skipping quoted attribute values, which may hold a raw `>`. */
function tagEnd(text: string, lt: number): number {
  let quote: string | undefined;
  for (let i = lt + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === '"' || char === '\'') quote = char;
    else if (char === '<') return -1;
    else if (char === '>') return i;
  }
  return -1;
}

const finished = (testcase: NonNullable<Open['testcase']>): TestCase => {
  const {suite, classname, name, file, failed, skipped} = testcase;
  return {suite, classname, name, ...(file === undefined ? {} : {file}), outcome: failed ? 'failed' : skipped ? 'skipped' : 'passed'};
};

/** Parses the report bytes; throws ReportRefused for anything it does not accept in full. */
export function parseJUnit(bytes: Buffer): ReportSummary {
  if (bytes.length > MAX_REPORT_BYTES) throw new ReportRefused('report_too_large', `the report has ${bytes.length} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw invalid('the report is not UTF-8');
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const stack: Open[] = [];
  const testcases: TestCase[] = [];
  const identities = new Set<string>();
  let rootSeen = false;
  let index = 0;
  let prologue = true;
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    const chunk = text.slice(index, lt === -1 ? text.length : lt);
    if (chunk.trim()) {
      if (stack.length === 0) throw invalid('text outside the root element');
      if (chunk.includes('>') && /]]>/.test(chunk)) throw invalid('stray CDATA end');
      decodeText(chunk);
    }
    if (lt === -1) break;
    if (text.startsWith('<?xml', lt) && prologue && lt === text.search(/\S/)) {
      const end = text.indexOf('?>', lt);
      if (end === -1) throw invalid('unterminated XML declaration');
      index = end + 2;
      prologue = false;
      continue;
    }
    prologue = false;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw invalid('unterminated comment');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw invalid('CDATA outside the root element');
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw invalid('unterminated CDATA');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw invalid('declarations (DOCTYPE, ENTITY) are not allowed');
    if (text.startsWith('<?', lt)) throw invalid('processing instructions are not allowed');
    const gt = tagEnd(text, lt);
    if (gt === -1) throw invalid('unterminated tag');
    const tag = text.slice(lt + 1, gt);
    index = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw invalid(`</${name}> does not close <${open?.name ?? 'nothing'}>`);
      if (open.testcase) testcases.push(finished(open.testcase));
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(body);
    if (!nameMatch) throw invalid(`malformed tag <${tag.slice(0, 40)}>`);
    const name = nameMatch[1];
    if (!ELEMENTS.has(name)) throw invalid(`element <${name}> is not a JUnit element`);
    const attributes = parseAttributes(body.slice(name.length));
    const parent = stack.at(-1);
    if (!parent) {
      if (rootSeen) throw invalid('more than one root element');
      if (name !== 'testsuites' && name !== 'testsuite') throw invalid(`the root is <${name}>`);
      rootSeen = true;
    }
    const open: Open = {name};
    if (name === 'testcase') {
      // node --test puts top-level tests directly under <testsuites>.
      if (parent?.name !== 'testsuite' && parent?.name !== 'testsuites') throw invalid('<testcase> outside a test suite');
      const caseName = attributes.get('name');
      if (!caseName) throw invalid('<testcase> without a name');
      const classname = attributes.get('classname') ?? '';
      const file = attributes.get('file');
      const suite = stack.flatMap((entry) => (entry.suiteName === undefined ? [] : [entry.suiteName]));
      const identity = JSON.stringify([suite, classname, caseName, file ?? null]);
      if (identities.has(identity)) throw invalid(`testcase ${caseName} appears twice`);
      identities.add(identity);
      if (identities.size > MAX_TESTCASES) throw invalid(`more than ${MAX_TESTCASES} testcases`);
      open.testcase = {suite, classname, name: caseName, ...(file === undefined ? {} : {file}), failed: false, skipped: false};
    } else if (name === 'failure' || name === 'error' || name === 'skipped') {
      if (!parent?.testcase) throw invalid(`<${name}> outside a <testcase>`);
      if (name === 'skipped') parent.testcase.skipped = true;
      else parent.testcase.failed = true;
    } else if (name === 'testsuite') {
      if (parent && parent.name !== 'testsuites' && parent.name !== 'testsuite') throw invalid(`<testsuite> inside <${parent.name}>`);
      open.suiteName = attributes.get('name') ?? '';
    }
    if (selfClosing) {
      if (open.testcase) testcases.push(finished(open.testcase));
      if (!parent) throw invalid('the root element is empty');
      continue;
    }
    stack.push(open);
    if (stack.length > MAX_DEPTH) throw invalid(`nested deeper than ${MAX_DEPTH}`);
  }
  if (!rootSeen) throw invalid('no root element');
  if (stack.length > 0) throw invalid(`<${stack.at(-1)?.name}> is never closed`);
  const count = (outcome: TestOutcome) => testcases.filter((testcase) => testcase.outcome === outcome).length;
  return {testcases, counts: {collected: testcases.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped')}};
}

/** The helper's entry: reads the report under `dir` (never following a symlink) and prints the summary or the refusal. */
export async function readReport(dir: string): Promise<{ok: true; summary: ReportSummary} | {ok: false; code: string; message: string}> {
  const file = `${dir}/${REPORT_FILE}`;
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat) return {ok: false, code: 'report_missing', message: `no ${REPORT_FILE} was written`};
  if (!stat.isFile()) return {ok: false, code: 'report_invalid', message: `${REPORT_FILE} is not a regular file`};
  if (stat.size > MAX_REPORT_BYTES) return {ok: false, code: 'report_too_large', message: `the report has ${stat.size} bytes`};
  try {
    return {ok: true, summary: parseJUnit(await fs.readFile(file))};
  } catch (error) {
    if (error instanceof ReportRefused) return {ok: false, code: error.code, message: error.message};
    throw error;
  }
}

if (require.main === module) {
  void readReport(process.env.SIFT_REPORT_DIR ?? '/report').then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }, (error: unknown) => {
    process.stdout.write(`${JSON.stringify({ok: false, code: 'report_invalid', message: (error as Error).message})}\n`);
    process.exitCode = 1;
  });
}
