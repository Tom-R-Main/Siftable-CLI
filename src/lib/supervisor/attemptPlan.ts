/**
 * The attempt plan a supervisor runs, and where it comes from (first-run U6
 * contract rev 2, D1). In production the plan is the one the server froze
 * when the setup launched, read after consume with
 * `GET /api/v1/work-items/:id/attempt-plan`; `--plan-file` is a test-only
 * override. Moved out of superviseLoop.ts to keep that file within its line
 * limit.
 */
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {ApiResult} from './attemptReport.js';
import type {TestPlan} from './attemptVerify.js';

export interface AttemptPlan {
  repositoryId: string;
  branch: string;
  baseSha: string;
  imageRef: string;
  /** The workload the launcher starts after `go`, exactly as the plan froze it. */
  command: string[];
  /** The checkout (U5b-2c): a public GitHub repository at baseSha, and the directories the writer may change. */
  repositoryUrl?: string;
  writeScope?: string[];
  /** Install the checkout's npm dependencies behind the registry-only proxy before the writer starts. */
  install?: {manager: 'npm'};
  /** Verification (U3-1): the test command, the selector for the failing test, and the test files to freeze. */
  test?: TestPlan;
  /** Review (U3-2): the pinned reviewer image and the reviewer model; needs `test`. */
  review?: {imageRef: string; model: string; policyRevision?: string};
  /** Skill versions the writer receives read-only at /sift/skills (skill-pin-v1.md). */
  skills?: Array<{key: string; version: number; sha256: string}>;
  /** The writer adapter's CLI and model (U6); required when the command is the adapter. */
  writer?: {protocol: 'anthropic' | 'openai'; model: string};
}

/** Where the writer adapter is mounted; a plan whose command starts it must name its writer. */
export const WRITER_ENTRY = '/sift/writer.js';

/** JSON with object keys sorted at every depth: the server hashes the frozen plan this way (evidence/hashing.ts). */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(sort(value));
}

export const planSha256 = (plan: AttemptPlan): string => createHash('sha256').update(canonicalJson(plan)).digest('hex');

/** Why the plan's writer cannot start, or undefined when it can. */
export function writerPlanProblem(plan: AttemptPlan): string | undefined {
  if (!plan.command.includes(WRITER_ENTRY)) return undefined;
  const writer = plan.writer;
  if (!writer || (writer.protocol !== 'anthropic' && writer.protocol !== 'openai')) return 'writer.protocol must be anthropic or openai';
  if (typeof writer.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(writer.model)) return 'writer.model must be a model id';
  return undefined;
}

/** Whether a value has the fields every plan needs; the specific checks run in the supervise loop. */
export function isAttemptPlan(value: unknown): value is AttemptPlan {
  const plan = value as Partial<AttemptPlan> | null;
  return Boolean(plan) && typeof plan === 'object' && typeof plan?.repositoryId === 'string' && typeof plan.branch === 'string'
    && /^[0-9a-f]{40}$/.test(String(plan.baseSha)) && typeof plan.imageRef === 'string'
    && Array.isArray(plan.command) && plan.command.every((part) => typeof part === 'string');
}

/**
 * The server's frozen plan for this work item, or null when there is none or
 * it cannot be trusted: a reply whose plan does not hash to its sha256 is
 * refused, never run. A failed read is retried within the caller's timeout.
 */
export async function serverPlan(get: (route: string) => Promise<ApiResult>, workItemId: string, workspaceId: string | null,
  attempts = 3): Promise<AttemptPlan | null> {
  const route = `/api/v1/work-items/${workItemId}/attempt-plan?workspaceId=${workspaceId ?? 'personal'}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const reply = await get(route).catch(() => null);
    if (reply?.status === 404) return null;
    if (reply?.status === 200) {
      const {plan, sha256} = reply.body as {plan?: unknown; sha256?: unknown};
      return isAttemptPlan(plan) && typeof sha256 === 'string' && planSha256(plan) === sha256 ? plan : null;
    }
  }
  return null;
}

/** The supervisor's read-only programs, mounted into the containers that run them. */
export function supervisorAssets() {
  return {sidecar: path.join(__dirname, 'relaySidecar.js'), launcher: path.join(__dirname, 'attemptLauncher.js'),
    checkoutHelper: path.join(__dirname, 'checkoutHelper.js'), registryProxy: path.join(__dirname, 'registryProxy.js'),
    junitReport: path.join(__dirname, 'junitReport.js'), writer: path.join(__dirname, 'writerAdapter.js')};
}
