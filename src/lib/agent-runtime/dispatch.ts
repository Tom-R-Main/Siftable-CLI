import {createHash} from 'node:crypto';

export const AGENT_RUNTIME_DISPATCH_VERSION = 1 as const;
export const AGENT_RUNTIME_DISPATCH_SURFACES = [
  'cli',
  't3',
  'codex',
  'claude-code',
  'mcp',
] as const;

export type AgentRuntimeDispatchSurface = (typeof AGENT_RUNTIME_DISPATCH_SURFACES)[number];

export interface AgentRuntimeDispatchWorkItem extends Record<string, unknown> {
  id: string;
}

export interface AgentRuntimeDispatchPlanV1 {
  schemaVersion: typeof AGENT_RUNTIME_DISPATCH_VERSION;
  dispatchId: string;
  planSha256: string;
  requestedBySurface: AgentRuntimeDispatchSurface;
  provider: 'aws';
  region: 'us-east-1';
  projectId: string;
  sourceGitSha: string;
  marketType: 'on-demand';
  workerCount: 2;
  maximumInstanceHours: 2;
  maximumRuntimeMinutes: number;
  executionEnabled: false;
  nextAction: 'review_then_execute_with_explicit_approval';
  workItems: Array<{
    id: string;
    revision: number;
    contractBindingSha256: string;
    writeScope: {include: string[]; exclude: string[]};
  }>;
}

export class AgentRuntimeDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRuntimeDispatchError';
  }
}

type ValidatedDispatchWorkItem = AgentRuntimeDispatchPlanV1['workItems'][number] & {projectId: string};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_LIKE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new AgentRuntimeDispatchError(message);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, field: string, nonEmpty = false): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim() !== entry || entry.length === 0)) {
    fail(`${field} must contain normalized non-empty strings.`);
  }
  if (nonEmpty && value.length === 0) fail(`${field} must not be empty.`);
  if (new Set(value as string[]).size !== value.length) fail(`${field} must not contain duplicates.`);
  return [...value as string[]].sort(compareCodePoints);
}

function normalizedScopePattern(pattern: string): string {
  const slashed = pattern.trim().replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
    fail(`Scope pattern ${pattern} must be repository-relative.`);
  }
  const parts = slashed.replace(/^(?:\.\/+)+/, '').split('/');
  if (parts.includes('..')) fail(`Scope pattern ${pattern} must not contain a .. segment.`);
  const normalized = parts.filter(part => part !== '' && part !== '.').join('/');
  if (!normalized) fail(`Scope pattern ${pattern} must not be empty.`);
  return normalized;
}

function scopeList(value: unknown, field: string, nonEmpty = false): string[] {
  const normalized = stringList(value, field, nonEmpty).map(normalizedScopePattern);
  if (new Set(normalized).size !== normalized.length) fail(`${field} must not contain normalized duplicates.`);
  return normalized.sort(compareCodePoints);
}

function pathMatchesPattern(candidate: string, pattern: string): boolean {
  const path = normalizedScopePattern(candidate);
  const scope = normalizedScopePattern(pattern);
  if (!path || !scope) return false;
  if (path === scope) return true;
  if (!/[?*]/.test(scope)) return path.startsWith(`${scope}/`);
  const doubleStar = '__SIFT_DOUBLE_STAR__';
  const expression = scope
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, '[^/]*')
    .replaceAll(doubleStar, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${expression}$`).test(path);
}

function literalScopePrefix(pattern: string): string {
  const literal: string[] = [];
  for (const segment of normalizedScopePattern(pattern).split('/')) {
    if (/[?*]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

function scopePatternsMayOverlap(left: string, right: string): boolean {
  const a = normalizedScopePattern(left);
  const b = normalizedScopePattern(right);
  if (!a || !b) return false;
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  const aPrefix = literalScopePrefix(a);
  const bPrefix = literalScopePrefix(b);
  if (!aPrefix || !bPrefix) return true;
  return aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`);
}

function scopePatternCovers(cover: string, candidate: string): boolean {
  const outer = normalizedScopePattern(cover);
  const inner = normalizedScopePattern(candidate);
  if (!outer || !inner) return false;
  if (outer === inner) return true;
  if (!/[?*]/.test(outer)) return inner.startsWith(`${outer}/`);
  if (!/[?*]/.test(inner)) return pathMatchesPattern(inner, outer);
  if (outer.endsWith('/**') && !/[?*]/.test(outer.slice(0, -3))) {
    const root = outer.slice(0, -3).replace(/\/+$/, '');
    return inner === root || inner.startsWith(`${root}/`);
  }
  return false;
}

function overlappingScopes(
  left: {include: string[]; exclude: string[]},
  right: {include: string[]; exclude: string[]},
): string[] {
  const exclusions = [...left.exclude, ...right.exclude];
  const overlaps = new Set<string>();
  for (const a of left.include) {
    for (const b of right.include) {
      if (!scopePatternsMayOverlap(a, b)) continue;
      const narrower = scopePatternCovers(a, b) ? b : scopePatternCovers(b, a) ? a : null;
      if (narrower && exclusions.some(excluded => scopePatternCovers(excluded, narrower))) continue;
      overlaps.add(a === b ? a : `${a} <-> ${b}`);
    }
  }
  return [...overlaps].sort(compareCodePoints);
}

function validateWorkItem(item: AgentRuntimeDispatchWorkItem): ValidatedDispatchWorkItem {
  if (!UUID.test(item.id)) {
    fail('Each work item must have a UUID id.');
  }
  if (item.status !== 'queued') fail(`Work item ${item.id} must be queued before dispatch.`);
  if (typeof item.projectId !== 'string' || !UUID_LIKE.test(item.projectId)) {
    fail(`Work item ${item.id} must belong to a Sift project.`);
  }
  if (item.claimOwner != null || item.claimExpiresAt != null) fail(`Work item ${item.id} is already claimed.`);
  const claimability = object(item.claimability, `Work item ${item.id} claimability`);
  if (claimability.state !== 'ready') fail(`Work item ${item.id} is not claimable.`);
  const summary = object(item.contractSummary, `Work item ${item.id} contractSummary`);
  if (summary.classification !== 'bounded' || summary.version !== 1 || summary.profile !== 'coding') {
    fail(`Work item ${item.id} must have a bounded version 1 coding contract.`);
  }
  const actions = object(item.allowedActions, `Work item ${item.id} allowedActions`);
  for (const action of ['read', 'write', 'test']) {
    if (actions[action] !== true) fail(`Work item ${item.id} must allow ${action}.`);
  }
  const verificationCommands = stringList(
    item.verificationCommands,
    `Work item ${item.id} verificationCommands`,
    true,
  );
  const writeScope = object(item.writeScope, `Work item ${item.id} writeScope`);
  const include = scopeList(writeScope.include, `Work item ${item.id} writeScope.include`, true);
  const exclude = scopeList(writeScope.exclude ?? [], `Work item ${item.id} writeScope.exclude`);
  const revision = item.revision;
  if (!Number.isInteger(revision) || Number(revision) < 1) fail(`Work item ${item.id} must have a positive revision.`);
  const normalizedId = item.id.toLowerCase();
  const contractBindingSha256 = sha256({
    id: normalizedId,
    revision,
    contractSummary: summary,
    acceptanceCriteria: item.acceptanceCriteria,
    allowedActions: actions,
    writeScope: {include, exclude},
    verificationCommands,
  });
  return {
    id: normalizedId,
    revision: Number(revision),
    contractBindingSha256,
    writeScope: {include, exclude},
    projectId: item.projectId.toLowerCase(),
  };
}

export function buildAgentRuntimeDispatchPlan(input: {
  requestedBySurface: AgentRuntimeDispatchSurface;
  sourceGitSha: string;
  maximumRuntimeMinutes?: number;
  workItems: AgentRuntimeDispatchWorkItem[];
}): AgentRuntimeDispatchPlanV1 {
  if (!AGENT_RUNTIME_DISPATCH_SURFACES.includes(input.requestedBySurface)) {
    fail('The dispatch surface is unsupported.');
  }
  const sourceGitSha = input.sourceGitSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceGitSha)) fail('sourceGitSha must be a full 40-character Git SHA.');
  const maximumRuntimeMinutes = input.maximumRuntimeMinutes ?? 120;
  if (!Number.isInteger(maximumRuntimeMinutes) || maximumRuntimeMinutes < 1 || maximumRuntimeMinutes > 120) {
    fail('maximumRuntimeMinutes must be between 1 and 120.');
  }
  if (input.workItems.length !== 2) fail('Exactly two work items are required for the bounded pilot.');
  const validated = input.workItems.map(validateWorkItem).sort((left, right) => compareCodePoints(left.id, right.id));
  if (validated[0].id === validated[1].id) fail('The two work items must be distinct.');
  if (validated[0].projectId !== validated[1].projectId) fail('The two work items must belong to the same Sift project.');
  const collisions = overlappingScopes(validated[0].writeScope, validated[1].writeScope);
  if (collisions.length > 0) {
    fail(`Work-item scopes overlap and must be serialized: ${collisions.join(', ')}`);
  }
  const projectId = validated[0].projectId;
  const workItems = validated.map(({projectId: _projectId, ...workItem}) => workItem);
  const binding = {
    schemaVersion: AGENT_RUNTIME_DISPATCH_VERSION,
    provider: 'aws' as const,
    region: 'us-east-1' as const,
    projectId,
    sourceGitSha,
    marketType: 'on-demand' as const,
    workerCount: 2 as const,
    maximumInstanceHours: 2 as const,
    maximumRuntimeMinutes,
    workItems,
  };
  const planSha256 = sha256(binding);
  return {
    ...binding,
    dispatchId: `agent-runtime:${planSha256.slice(0, 24)}`,
    planSha256,
    requestedBySurface: input.requestedBySurface,
    executionEnabled: false,
    nextAction: 'review_then_execute_with_explicit_approval',
  };
}
