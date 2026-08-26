import type {MergePacket} from "./mergeGate";
import type {MergeMasterWorkIdentity} from "./mergeMaster";

const MAX_REQUIRED_STEPS = 64;
const MAX_ACCEPTANCE_CRITERIA = 64;
const MAX_MERGE_FILES = 100;
const MAX_MERGE_CONFLICTS = 32;
const MAX_MERGE_OUT_OF_SCOPE = 64;
const MAX_MERGE_BLOCKERS = 32;
const MAX_SAFE_ARRAY = 8;
const MAX_SAFE_ENTRIES = 12;
const MAX_SAFE_DEPTH = 4;
const MAX_TEXT = 512;
const MAX_SHORT_TEXT = 256;
const MAX_READY_PACKET_BYTES = 96_000;
const MAX_RENDERED_PACKET_LENGTH = 16_000;
const TRUNCATED = "[TRUNCATED]";
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const VERIFIER_VERDICTS = new Set(["verified", "needs_review", "failed", "insufficient_evidence"]);
const COVERAGE_STATES = new Set(["unverified", "commands_passed", "verified", "failed"]);
const ATTEMPT_OUTCOMES = new Set(["passed", "failed", "error"]);
export const PROOF_HEAD_PROVENANCE_KEY = "siftReadyProofV1";

export const READY_PROOF_POLICIES = ["off", "warn", "enforce"] as const;
export type ReadyProofPolicy = typeof READY_PROOF_POLICIES[number];
export const DEFAULT_READY_PROOF_POLICY: ReadyProofPolicy = "warn";

export type ReadyProofCode =
  | "ready_proof_config_invalid"
  | "proof_not_required"
  | "proof_warn"
  | "work_link_required"
  | "identity_incomplete"
  | "identity_mismatch"
  | "scope_mismatch"
  | "work_status_invalid"
  | "work_verification_state_invalid"
  | "proof_load_failed"
  | "proof_receipt_missing"
  | "proof_receipt_stale"
  | "plan_stale"
  | "coverage_invalid"
  | "coverage_incomplete"
  | "coverage_duplicate"
  | "attempt_invalid"
  | "attempt_stale"
  | "base_not_contained"
  | "head_drift"
  | "base_drift"
  | "ready_proof_pass";

export function parseReadyProofPolicy(raw: string | undefined): ReadyProofPolicy {
  const value = raw?.trim();
  if (!value) return DEFAULT_READY_PROOF_POLICY;
  if ((READY_PROOF_POLICIES as readonly string[]).includes(value)) return value as ReadyProofPolicy;
  throw new Error("ready_proof_config_invalid");
}

export function resolveReadyProofPolicy(
  source: {SIFT_READY_PROOF_POLICY?: string} = process.env,
): {ok: true; policy: ReadyProofPolicy} | {ok: false; code: "ready_proof_config_invalid"} {
  try {
    return {ok: true, policy: parseReadyProofPolicy(source.SIFT_READY_PROOF_POLICY)};
  } catch {
    return {ok: false, code: "ready_proof_config_invalid"};
  }
}

type ApiResponse = {data?: unknown; error?: string; statusCode?: number};

export interface WorkProofClient {
  getWorkItem(workItemId: string): Promise<ApiResponse>;
  getWorkVerificationPlan(workItemId: string): Promise<ApiResponse>;
  listWorkItemVerifierRuns(workItemId: string): Promise<ApiResponse>;
}

export interface WorkProofAttempt {
  attemptId: string;
  outcome: "passed" | "failed" | "error";
  exitCode: number | null;
  environmentLabel: string;
  ranAt: string;
  output: string | null;
  artifactRefs: unknown[];
  provenance: Record<string, unknown>;
}

export interface WorkProofRequiredStep {
  id: string;
  key: string;
  title: string;
  kind: string;
  ordinal: number;
  latestAttempt: WorkProofAttempt | null;
}

export interface BoundedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface ReadyMergeEvidence {
  childSessionId: number;
  parentSessionId: number;
  baseBranch: string;
  childBranch: string;
  baseCommit: string;
  baseTip: string;
  behindBy: number;
  headCommit: string;
  changedFiles: BoundedList<{path: string; additions: number | null; deletions: number | null; binary: boolean}>;
  totalAdditions: number;
  totalDeletions: number;
  conflicts: BoundedList<string>;
  outOfScope: BoundedList<string>;
  dirty: boolean;
  verdict: MergePacket["verdict"];
  blockers: BoundedList<string>;
}

export type WorkProofVerifier =
  | {status: "recorded"; runId: string; verdict: string; planId: string; planVersion: number; createdAt: string}
  | {status: "not_recorded"; verdict: null}
  | {status: "unavailable"; verdict: null; reason: string};

export interface AvailableWorkProof {
  availability: "available";
  identity: {
    workItemId: string;
    title: string;
    revision: number;
    orgId: string | null;
    projectId: string | null;
    taskId: string | null;
    contract: MergeMasterWorkIdentity["contract"];
    activePlan: MergeMasterWorkIdentity["plan"];
    status: string;
    verificationState: string;
  };
  commands: {
    state: string;
    required: number;
    covered: number;
    passed: number;
    missingStepIds: string[];
    failedStepIds: string[];
    requiredSteps: WorkProofRequiredStep[];
  };
  verifier: WorkProofVerifier;
  acceptance: {
    status: "recorded" | "unavailable";
    total: number;
    met: number;
    unmet: number;
    criteria: Array<{ordinal: number; text: string; met: boolean}>;
    reason?: string;
  };
}

export type WorkProof = AvailableWorkProof | {
  availability: "unavailable";
  reason: "session_not_linked" | "contract_v1_unavailable" | "evidence_load_failed" | "identity_mismatch";
  detail: string;
};

export interface ReadyPacket {
  version: 1;
  merge: ReadyMergeEvidence;
  proof: WorkProof;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: string, limit = MAX_TEXT): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATED.length) return TRUNCATED.slice(0, limit);
  return `${value.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}

export function redactWorkProofText(value: unknown, limit = MAX_TEXT): string {
  let text = String(value ?? "");
  text = text
    .replace(/(bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:token|key|secret|signature|credential|password)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/((?:password|secret|token|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`);
  return bounded(text, limit);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SAFE_DEPTH) return TRUNCATED;
  if (typeof value === "string") return redactWorkProofText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const safe = value.slice(0, MAX_SAFE_ARRAY).map((entry) => sanitize(entry, depth + 1));
    if (value.length > MAX_SAFE_ARRAY) safe.push(TRUNCATED);
    return safe;
  }
  const record = object(value);
  if (!record) return "[UNSUPPORTED]";
  const entries = Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_SAFE_ENTRIES);
  const safe: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    const safeKey = redactWorkProofText(key, MAX_SHORT_TEXT);
    safe[safeKey] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(nested, depth + 1);
  }
  if (Object.keys(record).length > MAX_SAFE_ENTRIES) safe[TRUNCATED] = true;
  return safe;
}

function boundedList<T>(values: readonly T[], limit: number, project: (value: T) => T): BoundedList<T> {
  return {
    items: values.slice(0, limit).map(project),
    total: values.length,
    truncated: values.length > limit,
  };
}

function mergeEvidence(merge: MergePacket): ReadyMergeEvidence {
  return {
    childSessionId: merge.childSessionId,
    parentSessionId: merge.parentSessionId,
    baseBranch: redactWorkProofText(merge.baseBranch, MAX_SHORT_TEXT),
    childBranch: redactWorkProofText(merge.childBranch, MAX_SHORT_TEXT),
    baseCommit: redactWorkProofText(merge.baseCommit, 128),
    baseTip: redactWorkProofText(merge.baseTip, 128),
    behindBy: merge.behindBy,
    headCommit: redactWorkProofText(merge.headCommit, 128),
    changedFiles: boundedList(merge.files, MAX_MERGE_FILES, (file) => ({
      path: redactWorkProofText(file.path, MAX_TEXT),
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
    totalAdditions: merge.totalAdditions,
    totalDeletions: merge.totalDeletions,
    conflicts: boundedList(merge.conflicts, MAX_MERGE_CONFLICTS, (value) => redactWorkProofText(value, MAX_TEXT)),
    outOfScope: boundedList(merge.outOfScope, MAX_MERGE_OUT_OF_SCOPE, (value) => redactWorkProofText(value, MAX_TEXT)),
    dirty: merge.dirty,
    verdict: merge.verdict,
    blockers: boundedList(merge.blockers, MAX_MERGE_BLOCKERS, (value) => redactWorkProofText(value, MAX_TEXT)),
  };
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, MAX_REQUIRED_STEPS)
    .map((entry) => redactWorkProofText(entry, MAX_SHORT_TEXT));
}

function responseData(response: ApiResponse, label: string): Record<string, unknown> {
  if (
    response.error
    || (typeof response.statusCode === "number" && (response.statusCode < 200 || response.statusCode >= 300))
  ) {
    const status = typeof response.statusCode === "number" ? ` (${response.statusCode})` : "";
    throw new Error(`${label} failed${status}`);
  }
  const data = object(response.data);
  if (!data) throw new Error(`${label} returned no data`);
  return data;
}

function parseAttempt(value: unknown, identity: MergeMasterWorkIdentity, stepId: string): WorkProofAttempt | null {
  if (value === null || value === undefined) return null;
  const attempt = object(value);
  const attemptId = string(attempt?.attemptId);
  const outcome = string(attempt?.outcome);
  if (
    !attempt
    || !attemptId
    || !outcome
    || !ATTEMPT_OUTCOMES.has(outcome)
    || attempt.workItemId !== identity.workItemId
    || attempt.planId !== identity.plan.planId
    || attempt.planVersion !== identity.plan.planVersion
    || attempt.stepId !== stepId
  ) {
    throw new Error("latest verification attempt does not match the contracted plan");
  }
  return {
    attemptId: redactWorkProofText(attemptId, MAX_SHORT_TEXT),
    outcome: outcome as WorkProofAttempt["outcome"],
    exitCode: attempt.exitCode === null ? null : integer(attempt.exitCode) ?? null,
    environmentLabel: redactWorkProofText(string(attempt.environmentLabel) ?? "unknown", MAX_SHORT_TEXT),
    ranAt: redactWorkProofText(string(attempt.ranAt) ?? "unknown", MAX_SHORT_TEXT),
    output: attempt.output === null || attempt.output === undefined
      ? null
      : redactWorkProofText(attempt.output),
    artifactRefs: Array.isArray(attempt.artifactRefs)
      ? attempt.artifactRefs.slice(0, MAX_SAFE_ARRAY).map(() => REDACTED)
      : [],
    provenance: (() => {
      const provenance = object(attempt.provenance);
      const binding = object(provenance?.[PROOF_HEAD_PROVENANCE_KEY]);
      const headCommit = string(binding?.headCommit);
      return headCommit ? {[PROOF_HEAD_PROVENANCE_KEY]: {headCommit: redactWorkProofText(headCommit, 128)}} : {};
    })(),
  };
}

function parseRequiredSteps(value: unknown, identity: MergeMasterWorkIdentity): WorkProofRequiredStep[] {
  if (!Array.isArray(value)) throw new Error("verification coverage omitted step evidence");
  const required = value
    .map((entry) => object(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter((entry) => object(entry.step)?.required === true)
    .sort((left, right) => (integer(object(left.step)?.ordinal) ?? 0) - (integer(object(right.step)?.ordinal) ?? 0));
  if (required.length > MAX_REQUIRED_STEPS) throw new Error("verification plan exceeds the packet step limit");
  return required.map((entry) => {
    const step = object(entry.step);
    const id = string(step?.id);
    const key = string(step?.key);
    const title = string(step?.title);
    const kind = string(step?.kind);
    const ordinal = integer(step?.ordinal);
    if (
      !step
      || !id
      || !key
      || !title
      || !kind
      || ordinal === undefined
      || step.planId !== identity.plan.planId
      || step.workItemId !== identity.workItemId
      || step.planVersion !== identity.plan.planVersion
    ) {
      throw new Error("verification step identity does not match the contracted plan");
    }
    return {
      id: redactWorkProofText(id, MAX_SHORT_TEXT),
      key: redactWorkProofText(key, MAX_SHORT_TEXT),
      title: redactWorkProofText(title, MAX_SHORT_TEXT),
      kind: redactWorkProofText(kind, 64),
      ordinal,
      latestAttempt: parseAttempt(entry.latestAttempt, identity, id),
    };
  });
}

function parseAcceptance(value: unknown): AvailableWorkProof["acceptance"] {
  if (!Array.isArray(value)) throw new Error("work item omitted acceptance criteria");
  if (value.length > MAX_ACCEPTANCE_CRITERIA) throw new Error("acceptance criteria exceed the packet limit");
  const criteria = value.map((entry, index) => {
    const record = object(entry);
    const text = typeof entry === "string" ? entry : string(record?.text);
    if (!text) throw new Error("work item contains an invalid acceptance criterion");
    return {ordinal: index + 1, text: redactWorkProofText(text), met: record?.met === true};
  });
  const met = criteria.filter((criterion) => criterion.met).length;
  return {status: "recorded", total: criteria.length, met, unmet: criteria.length - met, criteria};
}

function acceptanceFromValue(value: unknown): AvailableWorkProof["acceptance"] {
  try {
    return parseAcceptance(value);
  } catch (error) {
    return {
      status: "unavailable",
      total: 0,
      met: 0,
      unmet: 0,
      criteria: [],
      reason: redactWorkProofText(error instanceof Error ? error.message : error, MAX_SHORT_TEXT),
    };
  }
}

function verifierFromResponse(response: ApiResponse, identity: MergeMasterWorkIdentity): WorkProofVerifier {
  try {
    const data = responseData(response, "verifier history");
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const matching = runs
      .map((entry) => object(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => entry.verificationPlanId === identity.plan.planId
        && entry.verificationPlanVersion === identity.plan.planVersion)
      .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))[0];
    if (!matching) return {status: "not_recorded", verdict: null};
    const runId = string(matching.id);
    const verdict = string(matching.verdict);
    const createdAt = string(matching.createdAt);
    if (!runId || !verdict || !VERIFIER_VERDICTS.has(verdict) || !createdAt) {
      return {status: "unavailable", verdict: null, reason: "matching verifier record is malformed"};
    }
    return {
      status: "recorded",
      runId: redactWorkProofText(runId, MAX_SHORT_TEXT),
      verdict,
      planId: redactWorkProofText(identity.plan.planId, MAX_SHORT_TEXT),
      planVersion: identity.plan.planVersion,
      createdAt: redactWorkProofText(createdAt, MAX_SHORT_TEXT),
    };
  } catch (error) {
    return {
      status: "unavailable",
      verdict: null,
      reason: redactWorkProofText(error instanceof Error ? error.message : error, MAX_SHORT_TEXT),
    };
  }
}

function unavailable(
  merge: MergePacket,
  reason: Extract<WorkProof, {availability: "unavailable"}>["reason"],
  detail: string,
): ReadyPacket {
  return unavailableWithMerge(mergeEvidence(merge), reason, detail);
}

function unavailableWithMerge(
  merge: ReadyMergeEvidence,
  reason: Extract<WorkProof, {availability: "unavailable"}>["reason"],
  detail: string,
): ReadyPacket {
  return {
    version: 1,
    merge,
    proof: {availability: "unavailable", reason, detail: redactWorkProofText(detail, MAX_SHORT_TEXT)},
  };
}

function boundPacketDetail(packet: ReadyPacket): ReadyPacket {
  if (Buffer.byteLength(JSON.stringify(packet)) <= MAX_READY_PACKET_BYTES) return packet;
  if (packet.proof.availability !== "available") return packet;
  const reduced = structuredClone(packet);
  if (reduced.proof.availability !== "available") return reduced;
  for (const step of reduced.proof.commands.requiredSteps) {
    if (!step.latestAttempt) continue;
    if (step.latestAttempt.output) step.latestAttempt.output = TRUNCATED;
    if (step.latestAttempt.artifactRefs.length > 0) step.latestAttempt.artifactRefs = [TRUNCATED];
    if (Object.keys(step.latestAttempt.provenance).length > 0) step.latestAttempt.provenance = {[TRUNCATED]: true};
  }
  if (Buffer.byteLength(JSON.stringify(reduced)) > MAX_READY_PACKET_BYTES) {
    return unavailableWithMerge(
      reduced.merge,
      "evidence_load_failed",
      "work proof exceeds the configured packet limit",
    );
  }
  return reduced;
}

async function loadLinkedReadyPacket(
  merge: MergePacket,
  identity: MergeMasterWorkIdentity,
  client: WorkProofClient,
): Promise<ReadyPacket> {
  try {
    const [workResponse, planResponse, verifierResponse] = await Promise.all([
      client.getWorkItem(identity.workItemId),
      client.getWorkVerificationPlan(identity.workItemId),
      Promise.resolve()
        .then(() => client.listWorkItemVerifierRuns(identity.workItemId))
        .catch(() => ({error: "verifier history unavailable"})),
    ]);
    const workItem = object(responseData(workResponse, "work item").workItem);
    const plan = object(responseData(planResponse, "verification plan").plan);
    const summary = object(workItem?.contractSummary);
    if (
      !workItem
      || workItem.id !== identity.workItemId
      || workItem.title !== identity.title
      || workItem.revision !== identity.revision
      || workItem.orgId !== identity.orgId
      || workItem.projectId !== identity.projectId
      || workItem.taskId !== identity.taskId
      || summary?.classification !== identity.contract.classification
      || summary?.profile !== identity.contract.profile
      || (identity.contract.version !== undefined && summary?.version !== identity.contract.version)
      || !plan
      || plan.id !== identity.plan.planId
      || plan.workItemId !== identity.workItemId
      || plan.version !== identity.plan.planVersion
      || plan.state !== identity.plan.state
    ) {
      return unavailable(merge, "identity_mismatch", "current work or plan identity differs from the contracted session");
    }

    const coverage = object(plan.coverage);
    const state = string(coverage?.state);
    const required = integer(coverage?.required);
    const covered = integer(coverage?.covered);
    const passed = integer(coverage?.passed);
    if (!coverage || !state || !COVERAGE_STATES.has(state) || required === undefined || covered === undefined || passed === undefined) {
      throw new Error("verification plan omitted bounded command coverage");
    }
    const requiredSteps = parseRequiredSteps(coverage.steps, identity);
    if (requiredSteps.length !== required) throw new Error("required step count does not match coverage");

    return boundPacketDetail({
      version: 1,
      merge: mergeEvidence(merge),
      proof: {
        availability: "available",
        identity: {
          workItemId: redactWorkProofText(identity.workItemId, MAX_SHORT_TEXT),
          title: redactWorkProofText(identity.title, MAX_SHORT_TEXT),
          revision: identity.revision as number,
          orgId: identity.orgId as string | null,
          projectId: identity.projectId as string | null,
          taskId: identity.taskId as string | null,
          contract: structuredClone(identity.contract),
          activePlan: {
            ...structuredClone(identity.plan),
            planId: redactWorkProofText(identity.plan.planId, MAX_SHORT_TEXT),
          },
          status: string(workItem.status) ?? "unknown",
          verificationState: string(workItem.verificationState) ?? "unknown",
        },
        commands: {
          state,
          required,
          covered,
          passed,
          missingStepIds: stringArray(coverage.missingStepIds),
          failedStepIds: stringArray(coverage.failedStepIds),
          requiredSteps,
        },
        verifier: verifierFromResponse(verifierResponse, identity),
        acceptance: acceptanceFromValue(workItem.acceptanceCriteria),
      },
    });
  } catch (error) {
    return unavailable(
      merge,
      "evidence_load_failed",
      error instanceof Error ? error.message : "work proof could not be loaded",
    );
  }
}

export function loadReadyPacket(
  merge: MergePacket,
  client: WorkProofClient,
): ReadyPacket | Promise<ReadyPacket> {
  const identity = merge.work;
  if (!identity) return unavailable(merge, "session_not_linked", "contract evidence unavailable for an unlinked session");
  if (identity.contract.version !== 1) {
    return unavailable(merge, "contract_v1_unavailable", "contract evidence is available only for Contract V1-linked sessions");
  }
  return loadLinkedReadyPacket(merge, identity, client);
}

function formatVerifier(verifier: WorkProofVerifier): string {
  if (verifier.status === "recorded") return `${verifier.verdict} · ${verifier.runId}`;
  if (verifier.status === "unavailable") return `unavailable · ${verifier.reason}`;
  return "not recorded";
}

export function formatReadyPacket(packet: ReadyPacket): string {
  const merge = packet.merge;
  const head = merge.verdict === "ready_to_merge" ? "✓ ready to merge" : "✗ merge blocked";
  const stat = `${merge.changedFiles.total} file(s), +${merge.totalAdditions} −${merge.totalDeletions}`;
  const drift = merge.behindBy > 0 ? `, base +${merge.behindBy} ahead` : "";
  const lines = [
    `#${merge.childSessionId} ${merge.childBranch} → ${merge.baseBranch}: ${head}`,
    `  ${stat}${drift} · base ${merge.baseTip} · head ${merge.headCommit} · ${merge.dirty ? "dirty" : "clean"}`,
    `  fork ${merge.baseCommit}`,
  ];
  if (packet.proof.availability === "unavailable") {
    lines.push(`  proof: unavailable (${packet.proof.reason}) · ${packet.proof.detail}`);
  } else {
    const proof = packet.proof;
    const contractVersion = proof.identity.contract.version === undefined ? "?" : proof.identity.contract.version;
    lines.push(
      `  work: ${proof.identity.workItemId} · Contract V${contractVersion} ${proof.identity.contract.profile}`,
      `  plan: ${proof.identity.activePlan.planId} v${proof.identity.activePlan.planVersion}`,
      `  commands: ${proof.commands.state} · ${proof.commands.passed}/${proof.commands.required} passed · ${proof.commands.covered}/${proof.commands.required} covered`,
      `  acceptance: ${proof.acceptance.status === "recorded"
        ? `${proof.acceptance.met}/${proof.acceptance.total} met`
        : `unavailable · ${proof.acceptance.reason ?? "presentation unavailable"}`}`,
      `  verifier: ${formatVerifier(proof.verifier)}`,
    );
  }
  if (merge.changedFiles.items.length > 0) {
    lines.push(`  changed: ${merge.changedFiles.items.map((file) => file.path).join(", ")}${merge.changedFiles.truncated ? ", …" : ""}`);
  }
  if (merge.conflicts.total > 0) {
    lines.push(`  conflicts: ${merge.conflicts.items.join(", ")}${merge.conflicts.truncated ? ", …" : ""}`);
  }
  if (merge.outOfScope.total > 0) {
    lines.push(`  out of scope: ${merge.outOfScope.items.join(", ")}${merge.outOfScope.truncated ? ", …" : ""}`);
  }
  for (const blocker of merge.blockers.items) lines.push(`  • ${blocker}`);
  if (merge.blockers.truncated) lines.push("  • … additional blockers truncated");
  if (packet.proof.availability === "unavailable") return bounded(lines.join("\n"), MAX_RENDERED_PACKET_LENGTH);

  const proof = packet.proof;
  if (proof.commands.missingStepIds.length > 0) {
    lines.push(`  missing steps: ${proof.commands.missingStepIds.join(", ")}`);
  }
  if (proof.commands.failedStepIds.length > 0) {
    lines.push(`  failed steps: ${proof.commands.failedStepIds.join(", ")}`);
  }
  for (const step of proof.commands.requiredSteps) {
    const attempt = step.latestAttempt;
    lines.push(`    ${step.ordinal}. ${step.key} [${step.kind}] · ${step.title} · step ${step.id}`);
    if (!attempt) {
      lines.push("       latest: missing");
      continue;
    }
    lines.push(
      `       latest: ${attempt.outcome} · exit ${attempt.exitCode ?? "none"} · ${attempt.attemptId}`,
      `       ran: ${attempt.environmentLabel} · ${attempt.ranAt}`,
    );
    if (attempt.output) lines.push(`       output: ${attempt.output}`);
    if (attempt.artifactRefs.length > 0) lines.push(`       artifacts: ${attempt.artifactRefs.length}`);
    const head = object(attempt.provenance[PROOF_HEAD_PROVENANCE_KEY])?.headCommit;
    if (typeof head === "string") lines.push(`       proof head: ${head}`);
  }
  for (const criterion of proof.acceptance.criteria) {
    lines.push(`    ${criterion.met ? "✓" : "○"} acceptance ${criterion.ordinal}: ${criterion.text}`);
  }
  return bounded(lines.join("\n"), MAX_RENDERED_PACKET_LENGTH);
}

export interface ReadyProofDecision {
  policy: ReadyProofPolicy;
  allowed: boolean;
  code: ReadyProofCode;
  receipt?: ReadyProofReceipt;
}

export interface ReadyProofReceipt {
  policy: ReadyProofPolicy;
  childHead: string;
  baseTip: string;
  workRevision: number;
  planId: string;
  planVersion: number;
  decisionKey: string;
}

function completeIdentity(identity: MergeMasterWorkIdentity | undefined): identity is MergeMasterWorkIdentity & {
  revision: number;
  orgId: string | null;
  projectId: string | null;
  taskId: string | null;
} {
  return Boolean(identity)
    && identity?.contract.classification === "bounded"
    && identity.contract.profile === "coding"
    && identity.contract.version === 1
    && typeof identity.revision === "number"
    && Number.isInteger(identity.revision)
    && identity.revision > 0
    && (["orgId", "projectId", "taskId"] as const).every((key) => (
      Object.hasOwn(identity, key) && (identity[key] === null || typeof identity[key] === "string")
    ));
}

function receiptKey(input: Omit<ReadyProofReceipt, "decisionKey">): string {
  return [input.policy, input.childHead, input.baseTip, input.workRevision, input.planId, input.planVersion].join(":");
}

export function evaluateReadyProof(input: {
  policy: ReadyProofPolicy;
  merge: MergePacket;
  packet?: ReadyPacket;
}): ReadyProofDecision {
  if (input.policy === "off") return {policy: "off", allowed: true, code: "proof_not_required"};
  if (input.policy === "warn") return {policy: "warn", allowed: true, code: "proof_warn"};
  const identity = input.merge.work;
  if (!identity) return {policy: "enforce", allowed: false, code: "work_link_required"};
  if (identity.contract.profile === "read_only") return {policy: "enforce", allowed: false, code: "work_link_required"};
  if (!completeIdentity(identity)) return {policy: "enforce", allowed: false, code: "identity_incomplete"};
  if (input.merge.behindBy !== 0) return {policy: "enforce", allowed: false, code: "base_not_contained"};
  const packet = input.packet;
  if (!packet || packet.proof.availability !== "available") {
    const code = packet?.proof.availability === "unavailable" && packet.proof.reason === "identity_mismatch"
      ? "identity_mismatch"
      : "proof_load_failed";
    return {policy: "enforce", allowed: false, code};
  }
  const proof = packet.proof;
  const live = proof.identity;
  if (live.workItemId !== identity.workItemId || live.title !== identity.title || live.revision !== identity.revision) {
    return {policy: "enforce", allowed: false, code: "identity_mismatch"};
  }
  if (live.orgId !== identity.orgId || live.projectId !== identity.projectId || live.taskId !== identity.taskId) {
    return {policy: "enforce", allowed: false, code: "scope_mismatch"};
  }
  if (live.status !== "needs_review" && live.status !== "done") {
    return {policy: "enforce", allowed: false, code: "work_status_invalid"};
  }
  if (live.verificationState !== "commands_passed") {
    return {policy: "enforce", allowed: false, code: "work_verification_state_invalid"};
  }
  if (
    live.activePlan.planId !== identity.plan.planId
    || live.activePlan.planVersion !== identity.plan.planVersion
    || live.activePlan.state !== "active"
  ) return {policy: "enforce", allowed: false, code: "plan_stale"};
  const commands = proof.commands;
  if (!Number.isInteger(commands.required) || commands.required <= 0) {
    return {policy: "enforce", allowed: false, code: "coverage_invalid"};
  }
  if (
    commands.state !== "commands_passed"
    || commands.covered !== commands.required
    || commands.passed !== commands.required
    || commands.missingStepIds.length !== 0
    || commands.failedStepIds.length !== 0
    || commands.requiredSteps.length !== commands.required
  ) return {policy: "enforce", allowed: false, code: "coverage_incomplete"};
  const ids = new Set<string>();
  const keys = new Set<string>();
  const ordinals = new Set<number>();
  for (const step of commands.requiredSteps) {
    if (ids.has(step.id) || keys.has(step.key) || ordinals.has(step.ordinal)) {
      return {policy: "enforce", allowed: false, code: "coverage_duplicate"};
    }
    ids.add(step.id); keys.add(step.key); ordinals.add(step.ordinal);
    if (!step.latestAttempt || step.latestAttempt.outcome !== "passed") {
      return {policy: "enforce", allowed: false, code: "attempt_invalid"};
    }
    const binding = object(step.latestAttempt.provenance[PROOF_HEAD_PROVENANCE_KEY]);
    if (binding?.headCommit !== input.merge.headCommit) {
      return {policy: "enforce", allowed: false, code: "attempt_stale"};
    }
  }
  const receiptBase = {
    policy: "enforce" as const,
    childHead: input.merge.headCommit,
    baseTip: input.merge.baseTip,
    workRevision: identity.revision,
    planId: identity.plan.planId,
    planVersion: identity.plan.planVersion,
  };
  return {
    policy: "enforce",
    allowed: true,
    code: "ready_proof_pass",
    receipt: {...receiptBase, decisionKey: receiptKey(receiptBase)},
  };
}

export function receiptMatches(
  receipt: ReadyProofReceipt | undefined,
  input: Omit<ReadyProofReceipt, "decisionKey">,
): boolean {
  return Boolean(receipt)
    && receipt?.decisionKey === receiptKey(input)
    && receipt.policy === input.policy
    && receipt.childHead === input.childHead
    && receipt.baseTip === input.baseTip
    && receipt.workRevision === input.workRevision
    && receipt.planId === input.planId
    && receipt.planVersion === input.planVersion;
}

export function loadReadyProof(input: {
  policy: ReadyProofPolicy;
  merge: MergePacket;
  client?: WorkProofClient;
}): ReadyPacket | Promise<ReadyPacket> | undefined {
  if (input.policy === "off") return undefined;
  if (!input.client) return unavailable(input.merge, "evidence_load_failed", "proof client unavailable");
  return loadReadyPacket(input.merge, input.client);
}

export function formatReadyProofDecision(decision: ReadyProofDecision): string {
  return `proof: ${decision.code}`;
}
