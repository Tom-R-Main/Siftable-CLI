export const WORK_DEPENDENCY_GATES = ['done', 'commands_passed', 'verified'] as const;

export type WorkDependencyGate = typeof WORK_DEPENDENCY_GATES[number];

export interface WorkDependencyInput {
  workItemId: string;
  requiredGate?: WorkDependencyGate;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isDependencyGate(value: unknown): value is WorkDependencyGate {
  return typeof value === 'string' && (WORK_DEPENDENCY_GATES as readonly string[]).includes(value);
}

/** Parse and validate the public dependency-write contract at the CLI boundary. */
export function parseWorkDependencies(value: string | undefined): WorkDependencyInput[] | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid dependencies JSON. Expected an array of {"workItemId":"<uuid>","requiredGate"?:"done"|"commands_passed"|"verified"}.');
  }

  if (!Array.isArray(parsed)) throw new Error('Dependencies must be a JSON array.');

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Dependency ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.workItemId !== 'string' || !UUID_PATTERN.test(record.workItemId)) {
      throw new Error(`Dependency ${index + 1} workItemId must be a UUID.`);
    }
    if (record.requiredGate !== undefined && !isDependencyGate(record.requiredGate)) {
      throw new Error(`Dependency ${index + 1} requiredGate must be done, commands_passed, or verified.`);
    }
    const normalizedId = record.workItemId.toLowerCase();
    if (seen.has(normalizedId)) {
      throw new Error(`Dependency ${index + 1} repeats work item ${record.workItemId}.`);
    }
    seen.add(normalizedId);
    return record.requiredGate === undefined
      ? {workItemId: record.workItemId}
      : {workItemId: record.workItemId, requiredGate: record.requiredGate};
  });
}

export function formatDependencies(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '-';
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') return '?';
    const record = entry as Record<string, unknown>;
    const id = typeof record.predecessorId === 'string' ? record.predecessorId : '?';
    const gate = typeof record.requiredGate === 'string' ? record.requiredGate : 'done';
    return `${id.slice(0, 8)}:${gate}${record.satisfied === true ? '✓' : ''}`;
  }).join(', ');
}

export function formatClaimability(value: unknown): string {
  if (!value || typeof value !== 'object') return '-';
  const state = (value as Record<string, unknown>).state;
  return typeof state === 'string' ? state : '-';
}
