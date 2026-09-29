/**
 * Static test-case extraction for Jev work-coverage shadow mode. No test is executed.
 *
 * TypeScript port of the audited v2 extractor
 * (docs/research/jev-work-review-audit/scripts/extract_cases.py). Behaviour, including
 * ordering and its documented limits, is kept identical so shadow records are comparable
 * with the audit labels:
 *
 * - comments are masked before scanning, so commented-out tests are not offered;
 * - `describe.skip`/`describe.todo` (and Playwright `test.describe.skip`/`.fixme`) propagate
 *   to every nested case (`skipped`);
 * - conditional gates are recognised and flagged: `const d = cond ? describe : describe.skip`,
 *   `(cond ? describe : describe.skip)(...)`, `describe.skipIf(cond)` / `describe.runIf(cond)`
 *   (and it/test), Playwright `test.skip(cond, ...)` inside a describe or at file level.
 *   `if (!process.env.X) return` guards are not detected (known limit);
 * - multiline assertions are captured whole (the full `expect(...).matcher(...)` chain), bounded.
 */

export const MAX_ASSERT = 12;
export const ASSERT_CHARS = 400;
export const BODY_CHARS = 4000;

const IDENT = '[A-Za-z_$][\\w$]*';
const WS = new Set([' ', '\n', '\t', '\r']);

export type ExtractedCase = {
  describePath: string[];
  title: string;
  flags: string[];
  gates: string[];
  assertions: string[];
  assertionsTruncated: boolean;
  line: number;
  /** Source offsets of the case call (comments masked; offsets equal the raw source's). */
  span: [number, number];
};

type Call = {
  kind: 'describe' | 'it' | 'test' | 'pw_skip';
  mod: string | null;
  start: number;
  end: number;
  title: string | null;
  dynamic: boolean;
  gate: string | null;
};

// ---------- lexical helpers ----------

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export function skipString(src: string, start: number): number {
  const q = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (q === '`' && c === '$' && i + 1 < src.length && src[i + 1] === '{') {
      i = matchClose(src, i + 1, '{', '}');
      continue;
    }
    if (c === q) return i + 1;
    if (q !== '`' && c === '\n') return i; // unterminated ordinary string: stop at line end
    i += 1;
  }
  return i;
}

/** Replace // and /* *\/ comments with spaces (newlines kept), leaving strings intact. */
export function maskComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (src.startsWith('//', i)) {
      let j = src.indexOf('\n', i);
      j = j < 0 ? n : j;
      for (let k = i; k < j; k++) out[k] = ' ';
      i = j;
      continue;
    }
    if (src.startsWith('/*', i)) {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** `i` at the opening char; returns the index after its match. Expects comments already masked. */
export function matchClose(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  const n = src.length;
  let i = start;
  while (i < n) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return n;
}

function literalTitle(src: string, i: number): [string | null, boolean] {
  let j = i + 1;
  while (j < src.length && WS.has(src[j])) j += 1;
  if (j >= src.length || !(src[j] === "'" || src[j] === '"' || src[j] === '`')) return [null, true];
  const end = skipString(src, j);
  const raw = src.slice(j + 1, end - 1);
  return [collapse(raw), src[j] === '`' && raw.includes('${')];
}

const ALNUM = /[\p{L}\p{N}]/u;

/** Complete expect(...) chains and assert calls in body, whitespace-collapsed and bounded. */
/** [start, end) ranges of string and template literals in comment-masked source. */
export function literalSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, i);
      spans.push([i, end]);
      i = Math.max(end, i + 1);
      continue;
    }
    i += 1;
  }
  return spans;
}

/** Whether offset `at` falls inside one of `spans` (sorted, non-overlapping). */
export function insideSpans(spans: ReadonlyArray<[number, number]>, at: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = spans[mid];
    if (at < a) hi = mid - 1;
    else if (at >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function assertions(body: string): string[] {
  const out: string[] = [];
  let covered = 0;
  const strings = literalSpans(body);
  const start = /\b(expect|assert)(\.\w+)?\s*\(/g;
  const chain = new RegExp(`\\.\\s*(${IDENT})`, 'y');
  for (const m of body.matchAll(start)) {
    const at = m.index ?? 0;
    if (at < covered) continue; // nested helper inside an assertion already captured
    if (insideSpans(strings, at)) continue; // text inside a string or template literal is not code
    if (at) {
      const prev = body[at - 1];
      if (ALNUM.test(prev) || prev === '_' || prev === '$' || prev === '.') continue;
    }
    let end = matchClose(body, at + m[0].length - 1, '(', ')');
    // follow the matcher chain: .not.toBe(...), .resolves.toEqual(...), .toHaveBeenCalledWith(...)
    for (;;) {
      let k = end;
      while (k < body.length && WS.has(body[k])) k += 1;
      chain.lastIndex = k;
      const mm = chain.exec(body);
      if (!mm) break;
      k += mm[0].length;
      while (k < body.length && WS.has(body[k])) k += 1;
      end = k < body.length && body[k] === '(' ? matchClose(body, k, '(', ')') : k;
    }
    covered = end;
    let text = collapse(body.slice(at, end)).trim();
    if (text.length > ASSERT_CHARS) text = text.slice(0, ASSERT_CHARS) + ' …';
    out.push(text);
  }
  return out;
}

// ---------- structure ----------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** name -> [kind, condition], for `const name = cond ? describe : describe.skip` style aliases. */
export function gateAliases(src: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  const positive = new RegExp(
    `(?:const|let|var)\\s+(${IDENT})\\s*=\\s*([^;\\n]*?)\\?\\s*(describe|it|test)\\s*:\\s*\\3\\.skip\\b`, 'g');
  const negative = new RegExp(
    `(?:const|let|var)\\s+(${IDENT})\\s*=\\s*([^;\\n]*?)\\?\\s*(describe|it|test)\\.skip\\s*:\\s*\\3\\b`, 'g');
  for (const m of src.matchAll(positive)) out.set(m[1], [m[3], collapse(m[2]).trim()]);
  for (const m of src.matchAll(negative)) out.set(m[1], [m[3], `!(${collapse(m[2]).trim()})`]);
  return out;
}

export function extract(srcRaw: string): ExtractedCase[] {
  const src = maskComments(srcRaw);
  const strings = literalSpans(src);
  const aliases = gateAliases(src);
  const names = ['describe', 'it', 'test', ...[...aliases.keys()].map(escapeRegExp)].join('|');
  const call = new RegExp(
    `(?<![\\w$.])(${names})(\\.(each|skip|only|todo|concurrent|sequential|skipIf|runIf|fixme))?\\s*(\\(|\`)`, 'g');
  const ternary = /\(\s*([^()]*?)\?\s*(describe|it|test)\s*:\s*\2\.skip\s*\)\s*\(/g;
  const pwDescribe = /(?<![\w$.])test\.describe(\.(only|skip|serial|parallel|fixme))?\s*\(/g;
  const calls: Call[] = [];

  const addCall = (kind: Call['kind'], mod: string | null, start: number, openAt: number, gate: string | null = null) => {
    const end = matchClose(src, openAt, '(', ')');
    const [title, dynamic] = literalTitle(src, openAt);
    calls.push({kind, mod, start, end, title, dynamic: dynamic || title === null, gate});
  };

  for (const m of src.matchAll(pwDescribe)) {
    const mod = m[2] ?? null;
    const at = m.index ?? 0;
    if (insideSpans(strings, at)) continue;
    addCall('describe', mod === 'skip' || mod === 'fixme' ? 'skip' : mod, at, at + m[0].length - 1);
  }
  for (const m of src.matchAll(ternary)) {
    const at = m.index ?? 0;
    if (insideSpans(strings, at)) continue;
    addCall(m[2] === 'describe' ? 'describe' : 'it', null, at, at + m[0].length - 1, collapse(m[1]).trim());
  }
  for (const m of src.matchAll(call)) {
    const name = m[1];
    const mod = m[3] ?? null;
    const at = m.index ?? 0;
    if (insideSpans(strings, at)) continue; // test-like text inside a string or template literal
    let kind: Call['kind'];
    let gate: string | null = null;
    if (name === 'describe' || name === 'it' || name === 'test') {
      kind = name;
    } else {
      const [aliasKind, aliasGate] = aliases.get(name)!;
      gate = aliasGate;
      kind = aliasKind === 'describe' ? 'describe' : 'it';
    }
    let openAt = at + m[0].length - 1;
    if (src[openAt] === '`') {
      const k = src.indexOf('(', skipString(src, openAt));
      if (k < 0) continue;
      openAt = k;
    } else if (mod === 'each' || mod === 'skipIf' || mod === 'runIf') {
      const argEnd = matchClose(src, openAt, '(', ')');
      if (mod === 'skipIf' || mod === 'runIf') {
        const cond = collapse(src.slice(openAt + 1, argEnd - 1)).trim();
        gate = mod === 'skipIf' ? `skip if ${cond}` : `run if ${cond}`;
      }
      let k = argEnd;
      while (k < src.length && WS.has(src[k])) k += 1;
      if (k >= src.length || src[k] !== '(') continue;
      openAt = k;
    }
    // Playwright conditional skip: test.skip(cond, 'reason') / test.skip(({...}) => cond)
    if (kind === 'test' && mod === 'skip') {
      const [title] = literalTitle(src, openAt);
      if (title === null) {
        const end = matchClose(src, openAt, '(', ')');
        calls.push({
          kind: 'pw_skip', mod: null, start: at, end, title: null, dynamic: false,
          gate: `playwright test.skip(${collapse(src.slice(openAt + 1, end - 1)).slice(0, 160)})`,
        });
        continue;
      }
    }
    addCall(kind, mod, at, openAt, gate);
  }

  const describes = calls.filter((c) => c.kind === 'describe');
  const pwSkips = calls.filter((c) => c.kind === 'pw_skip');
  const skipMods = new Set(['skip', 'todo', 'fixme']);
  const out: ExtractedCase[] = [];
  for (const c of calls) {
    if (c.kind === 'describe' || c.kind === 'pw_skip') continue;
    const parents = describes.filter((d) => d.start < c.start && c.start < d.end);
    const skipped = skipMods.has(c.mod ?? '') || parents.some((d) => skipMods.has(d.mod ?? ''));
    const gates = [c.gate, ...parents.map((d) => d.gate)].filter((g): g is string => Boolean(g));
    for (const s of pwSkips) { // a conditional test.skip in an enclosing describe (or at file level) gates this case
      const enclosing = describes.filter((d) => d.start < s.start && s.start < d.end);
      if (!enclosing.length || enclosing.slice(-1).some((d) => d.start < c.start && c.start < d.end)) {
        gates.push(s.gate!);
      }
    }
    const asserts = assertions(src.slice(c.start, c.end));
    const flagged: Array<[string, boolean]> = [
      ['dynamic_title', c.dynamic], ['parameterised', c.mod === 'each'], ['skipped', skipped],
      ['only', c.mod === 'only' || parents.some((d) => d.mod === 'only')], ['conditional_gate', gates.length > 0], ['no_assertions', asserts.length === 0],
    ];
    out.push({
      describePath: parents.map((d) => d.title || '<dynamic>'),
      title: c.title || '<dynamic>',
      flags: flagged.filter(([, on]) => on).map(([flag]) => flag),
      gates,
      assertions: asserts.slice(0, MAX_ASSERT),
      assertionsTruncated: asserts.length > MAX_ASSERT,
      line: countNewlines(src, c.start) + 1,
      span: [c.start, c.end],
    });
  }
  return out;
}

function countNewlines(src: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * The case body the audit sent to Jev (jev_v2_r2.py `body_of`): from the start of the case's
 * line to the close of the first call parenthesis on or after it, comments masked, at most
 * BODY_CHARS characters.
 */
/** The case's own call, from its first character to its closing parenthesis (comments masked), bounded. */
export function bodyAt(srcRaw: string, span: readonly [number, number]): string {
  return clip(maskComments(srcRaw).slice(span[0], span[1]), BODY_CHARS);
}

export function bodyOf(srcRaw: string, line: number): string {
  const src = maskComments(srcRaw);
  let start = 0;
  for (let seen = 1; seen < line; seen++) {
    const nl = src.indexOf('\n', start);
    if (nl < 0) {
      start = src.length;
      break;
    }
    start = nl + 1;
  }
  const k = src.indexOf('(', start);
  if (k < 0) return '';
  const end = matchClose(src, k, '(', ')');
  return clip(src.slice(start, end), BODY_CHARS);
}

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}
