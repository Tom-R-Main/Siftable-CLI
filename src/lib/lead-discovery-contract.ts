import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

interface LeadDiscoveryCommandRuntime {
  LEAD_DISCOVERY_COMMAND_CONTRACT_VERSION: number;
  LEAD_DISCOVERY_COMMAND_LIMITS: Readonly<{
    reviewNoteMaxLength: number;
    reviewBatchMaxItems: number;
  }>;
  LEAD_DISCOVERY_REVIEW_REASON_CODES: readonly string[];
  isLeadDiscoveryReviewReasonCodeForState(state: string, value: unknown): boolean;
}

let loadedRuntime: LeadDiscoveryCommandRuntime | undefined;

export function leadDiscoveryCommandRuntime(): LeadDiscoveryCommandRuntime {
  if (loadedRuntime) return loadedRuntime;
  const candidates = [
    resolve(__dirname, 'vendor', 'leadDiscoveryCommandContract.js'),
  ];
  const runtimePath = candidates.find(candidate => existsSync(candidate));
  if (!runtimePath) {
    throw new Error('Packaged lead-discovery command runtime is unavailable. Reinstall @siftable/cli.');
  }
  const runtime = require(runtimePath) as Partial<LeadDiscoveryCommandRuntime>;
  if (
    runtime.LEAD_DISCOVERY_COMMAND_CONTRACT_VERSION !== 2
    || !runtime.LEAD_DISCOVERY_COMMAND_LIMITS
    || !Array.isArray(runtime.LEAD_DISCOVERY_REVIEW_REASON_CODES)
    || typeof runtime.isLeadDiscoveryReviewReasonCodeForState !== 'function'
  ) {
    throw new Error(`Invalid canonical lead-discovery command runtime at ${runtimePath}`);
  }
  loadedRuntime = {
    LEAD_DISCOVERY_COMMAND_CONTRACT_VERSION: runtime.LEAD_DISCOVERY_COMMAND_CONTRACT_VERSION,
    LEAD_DISCOVERY_COMMAND_LIMITS: runtime.LEAD_DISCOVERY_COMMAND_LIMITS,
    LEAD_DISCOVERY_REVIEW_REASON_CODES: [...runtime.LEAD_DISCOVERY_REVIEW_REASON_CODES],
    isLeadDiscoveryReviewReasonCodeForState: runtime.isLeadDiscoveryReviewReasonCodeForState,
  };
  return loadedRuntime;
}

export function asJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function asJsonObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`${label} must be a non-empty JSON array of objects.`);
  }
  const maximum = leadDiscoveryCommandRuntime().LEAD_DISCOVERY_COMMAND_LIMITS.reviewBatchMaxItems;
  if (value.length > maximum) throw new Error(`${label} accepts at most ${maximum} items.`);
  return value as Array<Record<string, unknown>>;
}

export function assertReviewReasonCode(state: string, value: string): string {
  if (!leadDiscoveryCommandRuntime().isLeadDiscoveryReviewReasonCodeForState(state, value)) {
    throw new Error(`Unsupported ${state} review reason code: ${value}.`);
  }
  return value;
}
