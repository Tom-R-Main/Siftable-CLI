/**
 * Package-local copy of the public work-edit discovery contract.
 *
 * The published CLI cannot depend on the monorepo-only shared-contract
 * workspace package. A conformance test compares this value with the
 * authoritative shared contract so the distributable stays self-contained
 * without allowing the two surfaces to drift.
 */
export const AGENT_WORK_EDITABLE_FIELDS = [
  'title',
  'prompt',
  'queueRank',
  'inputContext',
  'acceptanceCriteria',
  'allowedActions',
  'writeScope',
  'verificationCommands',
  'contract',
] as const;

export const AGENT_WORK_EDIT_CAPABILITY = {
  commitmentClass: 'C2',
  useWhen: 'Revise queued, unclaimed work while preserving its UUID and dependency edges.',
  doNotUseWhen: 'Do not use after claim or execution; wait for a queued unclaimed state or create follow-up work.',
  example: 'Example: raise queue rank or refine acceptance criteria while the item is queued and unclaimed.',
  counterexample: 'Counterexample: do not change status, dependencies, or an active worker lease with this capability.',
  sideEffects: 'Execution-contract edits supersede the active verification plan and reset verification evidence; queue-rank-only edits do not.',
  duplicateBehavior: 'The same Idempotency-Key and payload replays the original receipt; a different payload with that key is rejected.',
} as const;
