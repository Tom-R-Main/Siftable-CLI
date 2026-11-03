/**
 * The skills an attempt's writer receives (skill-pin-v1.md, part B). The frozen
 * plan pins each skill by key, version and digest; the supervisor fetches the
 * files with the attempt's claim and checks every byte against the pins before
 * any writer exists. A skill changed after approval, a missing one or an extra
 * one fails the start. The checked files are written beside the attempt input
 * and bind-mounted read-only at /sift/skills.
 *
 * The digest and the file-set rules mirror the shared package's skillVersion
 * module (this package does not import it at runtime); the golden vectors in
 * docs/architecture/signing-golden-vectors.json pin both.
 */
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Session} from './attemptReport.js';
import {machineCanonicalJson} from './qualificationProtocol.js';

export const SKILLS_DIR = 'skills';
export const SKILLS_MOUNT = '/sift/skills';
const LIMITS = {maxFiles: 64, maxBytes: 256 * 1024, maxPathBytes: 200, maxPins: 8};
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface SkillPin {
  key: string;
  version: number;
  sha256: string;
}

export interface CheckedSkill extends SkillPin {
  files: Array<{path: string; bytes: Buffer}>;
}

const sha256Hex = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** sha256 hex over the canonical JSON of [{path, sha256, bytes}] sorted by path in UTF-16 code-unit order. */
export function skillDigest(files: ReadonlyArray<{path: string; sha256: string; bytes: number}>): string {
  const entries = [...files].sort((a, b) => byCodeUnit(a.path, b.path)).map(({path: file, sha256, bytes}) => ({path: file, sha256, bytes}));
  return sha256Hex(machineCanonicalJson(entries));
}

function pathProblem(file: string): string | undefined {
  if (typeof file !== 'string' || !file) return 'a file has no path';
  if (Buffer.byteLength(file, 'utf8') > LIMITS.maxPathBytes) return 'a path is too long';
  if (file.startsWith('/') || file.endsWith('/') || file.includes('\\')) return `${file}: not a plain relative path`;
  if ([...file].some((char) => char.charCodeAt(0) < 0x20 || char === '\u007f')) return `${file}: control character`;
  if (file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return `${file}: empty, "." or ".." segment`;
  return undefined;
}

/** The plan's pins, or why they are malformed: at most 8, distinct keys, each with a version and a digest. */
export function planSkillsProblem(skills: unknown): string | undefined {
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills) || skills.length > LIMITS.maxPins) return 'skills must be a list of at most 8 pins';
  const keys = new Set<string>();
  for (const pin of skills as Array<Partial<SkillPin>>) {
    if (!pin || typeof pin.key !== 'string' || !KEY.test(pin.key) || !Number.isSafeInteger(pin.version) || (pin.version ?? 0) < 1
      || typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) return 'a skill pin is malformed';
    if (keys.has(pin.key)) return `skill ${pin.key} is pinned twice`;
    keys.add(pin.key);
  }
  return undefined;
}

/**
 * The served skills checked against the plan's pins (Release #18034): exactly the pinned set, every path safe,
 * distinct and not also a directory, every file decoded and of its stated size and sha256, each skill within the
 * caps and of its pinned digest. Returns the decoded files, or why the start must fail.
 */
export function checkServedSkills(pins: readonly SkillPin[], served: unknown): CheckedSkill[] | string {
  if (!Array.isArray(served) || served.length !== pins.length) return 'the server did not serve exactly the pinned skills';
  const checked: CheckedSkill[] = [];
  for (const pin of pins) {
    const matches = (served as Array<Record<string, unknown>>).filter((skill) => skill?.key === pin.key);
    if (matches.length !== 1) return `skill ${pin.key} was not served exactly once`;
    const skill = matches[0];
    if (skill.version !== pin.version || skill.sha256 !== pin.sha256 || !Array.isArray(skill.files)) return `skill ${pin.key} is not the pinned version`;
    const files = skill.files as Array<Record<string, unknown>>;
    if (!files.length || files.length > LIMITS.maxFiles) return `skill ${pin.key} has the wrong number of files`;
    const paths = new Set<string>();
    const decoded: Array<{path: string; bytes: Buffer; sha256: string}> = [];
    let total = 0;
    for (const file of files) {
      const name = file?.path as string;
      const problem = pathProblem(name);
      if (problem) return `skill ${pin.key}: ${problem}`;
      if (paths.has(name)) return `skill ${pin.key}: ${name} listed twice`;
      paths.add(name);
      if (typeof file.content !== 'string' || !BASE64.test(file.content)) return `skill ${pin.key}: ${name} is not base64`;
      const bytes = Buffer.from(file.content, 'base64');
      total += bytes.length;
      if (total > LIMITS.maxBytes) return `skill ${pin.key} is over ${LIMITS.maxBytes} bytes`;
      if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256) return `skill ${pin.key}: ${name} does not match its size and sha256`;
      decoded.push({path: name, bytes, sha256: file.sha256 as string});
    }
    for (const name of paths) {
      const parts = name.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (paths.has(parts.slice(0, depth).join('/'))) return `skill ${pin.key}: ${name}'s directory is also a file`;
      }
    }
    if (!paths.has('SKILL.md')) return `skill ${pin.key} has no SKILL.md`;
    if (skillDigest(decoded.map((file) => ({path: file.path, sha256: file.sha256, bytes: file.bytes.length}))) !== pin.sha256) {
      return `skill ${pin.key} changed after the plan was approved`;
    }
    checked.push({...pin, files: decoded.map(({path: name, bytes}) => ({path: name, bytes}))});
  }
  return checked;
}

/** Writes the checked skills under `<inputDir>/skills/<key>/`, readable by the writer's uid and nothing more. */
export async function writeSkills(inputDir: string, skills: readonly CheckedSkill[]): Promise<string> {
  const root = path.join(inputDir, SKILLS_DIR);
  await fs.mkdir(root, {recursive: true, mode: 0o755});
  for (const skill of skills) {
    for (const file of skill.files) {
      const target = path.join(root, skill.key, file.path);
      await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o755});
      await fs.writeFile(target, file.bytes, {mode: 0o444, flag: 'wx'});
    }
  }
  return root;
}

/**
 * Fetches the plan's skills with the attempt's claim, checks them byte for byte and writes them, all before any
 * writer exists; returns why the start must fail, or undefined. A plan without skills fetches nothing.
 */
export async function prepareSkills(session: Pick<Session, 'call'>,
  attempt: {workItemId: string; attemptId: string; claimToken: string; timeoutMs: number; signal?: AbortSignal},
  pins: readonly SkillPin[] | undefined, inputDir: string): Promise<string | undefined> {
  if (!pins?.length) return undefined;
  const route = `/api/v1/work-items/${attempt.workItemId}/execution-attempts/${attempt.attemptId}/skills`;
  const reply = await session.call('POST', route, {claimToken: attempt.claimToken},
    {timeoutMs: attempt.timeoutMs, ...(attempt.signal ? {signal: attempt.signal} : {})}).catch(() => null);
  if (reply?.status !== 200) return `the server did not serve the plan's skills (HTTP ${reply?.status ?? 'unknown'})`;
  const checked = checkServedSkills(pins, reply.body.skills);
  if (typeof checked === 'string') return checked;
  await writeSkills(inputDir, checked);
  return undefined;
}
