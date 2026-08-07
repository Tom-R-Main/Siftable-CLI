import {
  WORK_CONTRACT_ACTIONS,
  parseWorkContract,
  type WorkContractAction,
  type WorkContractParseResult,
  type WorkContractProfile,
  type WorkContractV1,
  type WorkContractViolation,
} from '@siftable/mcp-server/dist/exfClient.js';

export type WorkContractCliProfile = 'coding' | 'read-only' | 'read_only';

export type WorkContractBuildInput = {
  profile: WorkContractProfile;
  acceptanceCriteria?: unknown[];
  allowedActions?: unknown;
  writeScope?: unknown;
  verificationCommands?: string[];
};

export type WorkContractCheckResult = {
  valid: boolean;
  classification: WorkContractParseResult['classification'];
  contract: WorkContractV1 | null;
  violations: WorkContractViolation[];
};

const CONTRACT_MISSING: WorkContractViolation = {
  path: 'contract',
  code: 'contract_missing',
  message: 'A bounded Work Contract V1 envelope is required.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function defaultWorkContractActions(profile: WorkContractProfile): Record<WorkContractAction, boolean> {
  return Object.fromEntries(WORK_CONTRACT_ACTIONS.map((action) => [
    action,
    profile === 'coding'
      ? action === 'read' || action === 'write' || action === 'test'
      : action === 'read',
  ])) as Record<WorkContractAction, boolean>;
}

export function normalizeWorkContractProfile(profile: WorkContractCliProfile): WorkContractProfile {
  return profile === 'coding' ? 'coding' : 'read_only';
}

export function buildWorkContract(input: WorkContractBuildInput): WorkContractParseResult {
  return parseWorkContract({
    version: 1,
    profile: input.profile,
    outcome: {acceptanceCriteria: input.acceptanceCriteria ?? []},
    authority: {
      allowedActions: input.allowedActions === undefined
        ? defaultWorkContractActions(input.profile)
        : input.allowedActions,
    },
    boundary: {
      writeScope: input.writeScope === undefined
        ? {include: [], exclude: []}
        : input.writeScope,
    },
    proof: {verificationCommands: input.verificationCommands ?? []},
  });
}

export function requireBuiltWorkContract(input: WorkContractBuildInput): WorkContractV1 {
  const parsed = buildWorkContract(input);
  const result: WorkContractCheckResult = {
    valid: parsed.classification === 'bounded',
    classification: parsed.classification,
    contract: parsed.contract,
    violations: parsed.classification === 'legacy' ? [CONTRACT_MISSING] : parsed.violations,
  };
  if (!result.valid || !result.contract) throw new WorkContractValidationError(result);
  return result.contract;
}

function workItemContractCandidate(workItem: Record<string, unknown>): unknown {
  if (isRecord(workItem.contract)) return workItem.contract;
  const summary = isRecord(workItem.contractSummary)
    ? workItem.contractSummary
    : isRecord(workItem.contract_summary)
      ? workItem.contract_summary
      : undefined;
  if (!summary || summary.classification === 'legacy') return undefined;
  return {
    version: summary.version,
    profile: summary.profile,
    outcome: {acceptanceCriteria: workItem.acceptanceCriteria ?? workItem.acceptance_criteria ?? []},
    authority: {allowedActions: workItem.allowedActions ?? workItem.allowed_actions ?? {}},
    boundary: {writeScope: workItem.writeScope ?? workItem.write_scope ?? {include: [], exclude: []}},
    proof: {verificationCommands: workItem.verificationCommands ?? workItem.verification_commands ?? []},
  };
}

export function checkWorkContract(input: unknown): WorkContractCheckResult {
  const parsed = parseWorkContract(input);
  return {
    valid: parsed.classification === 'bounded',
    classification: parsed.classification,
    contract: parsed.contract,
    violations: parsed.classification === 'legacy' ? [CONTRACT_MISSING] : parsed.violations,
  };
}

export function checkWorkItemContract(input: unknown): WorkContractCheckResult {
  const candidate = isRecord(input) ? workItemContractCandidate(input) : input;
  const parsed = parseWorkContract(candidate);
  return {
    valid: parsed.classification === 'bounded',
    classification: parsed.classification,
    contract: parsed.contract,
    violations: parsed.classification === 'legacy' ? [CONTRACT_MISSING] : parsed.violations,
  };
}

export class WorkContractValidationError extends Error {
  readonly code = 'work_contract_invalid';
  readonly statusCode = 400;
  readonly api: Record<string, unknown>;

  constructor(result: WorkContractCheckResult) {
    const detail = result.violations
      .map((violation) => `${violation.path || 'contract'} [${violation.code}]: ${violation.message}`)
      .join('; ');
    super(`Invalid Work Contract V1: ${detail}`);
    this.name = 'WorkContractValidationError';
    this.api = {
      type: this.code,
      title: 'Invalid Work Contract V1',
      detail: 'Correct the reported Work Contract violations and retry.',
      extra: {classification: result.classification, violations: result.violations},
    };
  }
}

export function requireBoundedWorkContract(input: unknown): WorkContractV1 {
  const result = checkWorkContract(input);
  if (!result.valid || !result.contract) throw new WorkContractValidationError(result);
  return result.contract;
}
