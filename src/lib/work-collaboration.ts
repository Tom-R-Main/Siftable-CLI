import {Flags} from '@oclif/core';
import {sanitizeTerminalLine, truncate} from './output.js';

export const collaborationActorFlag = Flags.string({
  description: 'Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)',
});

export type CollaborationActorFlags = {
  'as-agent-id'?: string;
};

export type CollaborationResponse = Record<string, unknown>;

const COLLABORATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const REDACTED = '[REDACTED]';
const SENSITIVE_PREVIEW_KEY = /^(?:(?:[a-z0-9]+_)*)(?:authorization|cookie|password|passwd|passphrase|password_hash|secret|token|token_hash|credential|credentials|api_key|access_key(?:_id)?|private_key|client_secret|access_token|refresh_token|id_token|session_token)(?:_header)?(?:_value)?$/u;

function isSensitivePreviewKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  return SENSITIVE_PREVIEW_KEY.test(normalized);
}

function redactPreviewAssignment(
  match: string,
  prefix: string,
  quote: string,
  key: string,
  separator: string,
  assignedValue: string,
): string {
  if (!isSensitivePreviewKey(key)) return match;
  const valueQuote = assignedValue.startsWith('"') || assignedValue.startsWith("'")
    ? assignedValue.charAt(0)
    : '';
  const replacement = valueQuote ? `${valueQuote}${REDACTED}${valueQuote}` : REDACTED;
  return `${prefix}${quote}${key}${quote}${separator}${replacement}`;
}

/** Redact high-confidence credential shapes from human-only event previews. */
function redactCollaborationPreviewSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
      REDACTED,
    )
    .replace(/(bearer\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(
      /([?&](?:token|key|secret|signature|credential|password)=)[^&\s]+/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /(^|[\s,{;])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)("(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s,;]+)/gimu,
      redactPreviewAssignment,
    )
    .replace(
      /(^\s*(?:authorization|proxy[-_ ]authorization|cookie|set[-_ ]cookie)\s*:\s*).*$/gimu,
      `$1${REDACTED}`,
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sift_pat_[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/gu,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED,
    )
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu, `$1${REDACTED}@`);
}

export function normalizeCollaborationIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8
    || normalized.length > 128
    || !COLLABORATION_KEY.test(normalized)
    || normalized.startsWith('system:')
  ) {
    throw new Error('Idempotency key must be 8-128 allowed characters and must not use the reserved system: prefix.');
  }
  return normalized;
}

export function normalizeCollaborationConsumerKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !COLLABORATION_KEY.test(normalized)) {
    throw new Error('Consumer key must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.');
  }
  return normalized;
}

export function resolveCollaborationActorAgentAliasId(
  flags: CollaborationActorFlags,
): string | undefined {
  const value = flags['as-agent-id'] ?? process.env.SIFT_AGENT_ALIAS_ID;
  const normalized = value?.trim();
  return normalized || undefined;
}

export function collaborationActorOptions(
  flags: CollaborationActorFlags,
): {actorAgentAliasId?: string} {
  const actorAgentAliasId = resolveCollaborationActorAgentAliasId(flags);
  return actorAgentAliasId ? {actorAgentAliasId} : {};
}

export function collaborationData(value: unknown): CollaborationResponse {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CollaborationResponse
    : {};
}

function collaborationRecords(value: unknown): CollaborationResponse[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is CollaborationResponse => (
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ))
    : [];
}

function actorLabel(actor: unknown): string {
  const value = collaborationData(actor);
  return sanitizeTerminalLine(value.label ?? value.id ?? value.kind ?? 'unknown');
}

export function renderCollaborationParticipants(data: CollaborationResponse): string {
  const participants = collaborationRecords(data.participants);
  if (participants.length === 0) return 'No collaboration participants found.';
  return participants.map((participant) => {
    const actor = collaborationData(participant.actor);
    const active = participant.active === false ? 'inactive' : 'active';
    return [
      sanitizeTerminalLine(participant.id ?? 'unknown'),
      sanitizeTerminalLine(participant.role ?? 'unknown'),
      sanitizeTerminalLine(actor.kind ?? 'unknown'),
      actorLabel(actor),
      active,
    ].join('  ');
  }).join('\n');
}

function eventTextPreview(event: CollaborationResponse): string {
  const text = collaborationRecords(event.parts)
    .filter((part) => part.kind === 'text')
    .map((part) => String(part.text ?? ''))
    .join(' ');
  return truncate(sanitizeTerminalLine(redactCollaborationPreviewSecrets(text)), 500);
}

function eventReferenceSummary(event: CollaborationResponse): string {
  const references = collaborationRecords(event.parts)
    .filter((part) => part.kind !== 'text')
    .map((part) => {
      const reference = part.artifactId ?? part.workItemId ?? '';
      return `${sanitizeTerminalLine(part.kind ?? 'reference')}:${sanitizeTerminalLine(reference)}`;
    });
  return references.join(', ');
}

/** One redacted, terminal-safe line for a ledger event. */
export function renderCollaborationEventLine(event: CollaborationResponse): string {
  const preview = eventTextPreview(event) || eventReferenceSummary(event) || '—';
  return [
    `#${sanitizeTerminalLine(event.sequence ?? '?')}`,
    sanitizeTerminalLine(event.kind ?? 'unknown'),
    actorLabel(event.actor),
    preview,
  ].join('  ');
}

export function renderCollaborationEvents(data: CollaborationResponse): string {
  const events = collaborationRecords(data.events);
  const serverPageLastSequence = Number.isSafeInteger(data.nextSequence) && Number(data.nextSequence) >= 0
    ? Number(data.nextSequence)
    : null;
  const deliveredSequences = events.map((event) => event.sequence);
  const deliveredSequence = events.length > 0
    && deliveredSequences.every((sequence) => Number.isSafeInteger(sequence) && Number(sequence) >= 0)
    ? Math.max(...deliveredSequences.map(Number))
    : null;
  const lines = events.map(renderCollaborationEventLine);
  if (events.length === 0) lines.push(data.timedOut === true ? 'Wait timed out with no events.' : 'No collaboration events found.');
  if (typeof data.consumerKey === 'string') lines.push(`Consumer: ${sanitizeTerminalLine(data.consumerKey)}`);
  if (serverPageLastSequence !== null) lines.push(`Server page watermark: ${serverPageLastSequence}`);
  if (typeof data.consumerKey === 'string' && events.length > 0 && deliveredSequence !== null) {
    const workItemId = events[0]?.workItemId ?? '<work-item-id>';
    lines.push('Cursor was not acknowledged. After durable processing, run:');
    lines.push(
      `sift work collaboration acknowledge ${sanitizeTerminalLine(workItemId)} --consumer-key ${sanitizeTerminalLine(data.consumerKey)} --last-sequence ${deliveredSequence}`,
    );
  } else if (typeof data.consumerKey === 'string') {
    lines.push('No safely acknowledgeable events were delivered; cursor unchanged and no acknowledgement is needed.');
  } else {
    lines.push('This listing did not advance any durable cursor.');
  }
  return lines.join('\n');
}

export function renderCollaborationParticipantMutation(
  data: CollaborationResponse,
  verb: 'Added' | 'Removed',
): string {
  const participant = collaborationData(data.participant);
  return `${verb} participant: ${sanitizeTerminalLine(participant.id ?? 'unknown')} (${sanitizeTerminalLine(participant.role ?? 'unknown')})`;
}

export function renderCollaborationEventMutation(data: CollaborationResponse): string {
  const event = collaborationData(data.event);
  return `Sent event: #${sanitizeTerminalLine(event.sequence ?? '?')} ${sanitizeTerminalLine(event.kind ?? 'unknown')} ${eventTextPreview(event)}`.trim();
}

export function renderCollaborationCursor(data: CollaborationResponse): string {
  const cursor = collaborationData(data.cursor);
  return `Acknowledged ${sanitizeTerminalLine(cursor.consumerKey ?? 'unknown')} through exact sequence ${sanitizeTerminalLine(cursor.lastSequence ?? '?')}.`;
}
