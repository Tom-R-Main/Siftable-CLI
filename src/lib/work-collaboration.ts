import {Flags} from '@oclif/core';
import {sanitizeTerminalLine, truncate} from './output.js';

export const collaborationActorFlag = Flags.string({
  description: 'Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)',
});

export type CollaborationActorFlags = {
  'as-agent-id'?: string;
};

export type CollaborationResponse = Record<string, unknown>;

/** Participant ID (lowercase) to the terminal-safe label shown for it. */
export type CollaborationParticipantLabels = ReadonlyMap<string, string>;

export type CollaborationEventsRenderOptions = {
  labels?: CollaborationParticipantLabels;
  /** The listing used `audience: 'me'`, so `nextSequence` also covers skipped events. */
  forMe?: boolean;
  workItemId?: string;
};

/** Mirrors AGENT_WORK_COLLABORATION_LIMITS.maxRecipients; the CLI does not load the shared package at runtime. */
const MAX_COLLABORATION_RECIPIENTS = 20;
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

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu;
const BEARER_VALUE = /(bearer\s+)[^\s,;]+/giu;
const URL_SECRET_PARAM = /([?&](?:token|key|secret|signature|credential|password)=)[^&\s]+/giu;
const ASSIGNMENT = /(^|[\s,{;])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)("(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s,;]+)/gimu;
const CREDENTIAL_HEADER = /(^\s*(?:authorization|proxy[-_ ]authorization|cookie|set[-_ ]cookie)\s*:\s*).*$/gimu;
const TOKEN_SHAPE = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sift_pat_[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/gu;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const URL_USERINFO = /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu;

/** Redact high-confidence credential shapes from human-only event previews. */
export function redactCollaborationPreviewSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(BEARER_VALUE, `$1${REDACTED}`)
    .replace(URL_SECRET_PARAM, `$1${REDACTED}`)
    .replace(ASSIGNMENT, redactPreviewAssignment)
    .replace(CREDENTIAL_HEADER, `$1${REDACTED}`)
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(JWT_SHAPE, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`);
}

/**
 * Where to cut `value` for a preview of about `limit` characters: at `limit`,
 * or later only to the end of a credential that starts before the cut. The cut
 * is measured on the source text, so redaction cannot pull later text into the
 * preview; the returned prefix still contains every straddling credential whole.
 */
function collaborationPreviewCut(value: string, limit: number): number {
  let cut = limit;
  for (let extended = true; extended;) {
    extended = false;
    for (const pattern of [PRIVATE_KEY_BLOCK, BEARER_VALUE, URL_SECRET_PARAM, ASSIGNMENT, CREDENTIAL_HEADER, TOKEN_SHAPE, JWT_SHAPE, URL_USERINFO]) {
      for (const match of value.matchAll(pattern)) {
        const end = match.index + match[0].length;
        if (match.index >= cut || end <= cut) continue;
        if (pattern === ASSIGNMENT && !isSensitivePreviewKey(match[3] ?? '')) continue;
        cut = end;
        extended = true;
      }
    }
  }
  return cut;
}

/**
 * A redacted, terminal-safe preview of about `limit` characters. The cut is
 * taken on the source text and extended only through a credential that
 * straddles it, so redaction never pulls later text into the preview.
 */
export function redactedPreview(value: string, limit: number): string {
  if (value.length <= limit) return sanitizeTerminalLine(redactCollaborationPreviewSecrets(value));
  const cut = collaborationPreviewCut(value, limit - 1);
  const preview = sanitizeTerminalLine(redactCollaborationPreviewSecrets(value.slice(0, cut)));
  return cut < value.length ? `${preview}…` : preview;
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

function participantCandidate(participant: CollaborationResponse): string {
  return `${sanitizeTerminalLine(participant.id ?? 'unknown')} (${actorLabel(participant.actor)}, ${sanitizeTerminalLine(participant.role ?? 'unknown')})`;
}

function participantCandidates(participants: CollaborationResponse[]): string {
  return participants.length > 0 ? participants.map(participantCandidate).join('; ') : 'none';
}

function participantMatchesRecipientRef(participant: CollaborationResponse, ref: string): boolean {
  const actor = collaborationData(participant.actor);
  const folded = ref.toLowerCase();
  return [participant.id, actor.id, actor.label].some((value) => (
    typeof value === 'string' && value.toLowerCase() === folded
  ));
}

/**
 * Resolve `--to` references against a work item's participant listing. A
 * reference is a participant UUID, an actor ID (agent alias or user UUID), or
 * an actor label, all compared without regard to case. Only active participants
 * qualify, and each reference must name exactly one of them. Returns lowercase,
 * unique, sorted participant IDs, so the same references give the same body.
 */
export function resolveCollaborationRecipients(
  data: CollaborationResponse,
  refs: readonly string[],
): string[] {
  const participants = collaborationRecords(data.participants)
    .filter((participant) => typeof participant.id === 'string');
  const active = participants.filter((participant) => participant.active === true);
  const ids = new Set<string>();
  for (const value of refs) {
    const ref = value.trim();
    if (!ref) throw new Error('--to must name a participant.');
    const shown = sanitizeTerminalLine(ref);
    const matches = active.filter((participant) => participantMatchesRecipientRef(participant, ref));
    const [match] = matches;
    if (match && matches.length === 1) {
      ids.add(String(match.id).toLowerCase());
      continue;
    }
    if (matches.length > 1) {
      throw new Error(`--to "${shown}" matches ${matches.length} active participants: ${participantCandidates(matches)}. Use a participant ID.`);
    }
    const inactive = participants.filter((participant) => (
      participant.active !== true && participantMatchesRecipientRef(participant, ref)
    ));
    if (inactive.length > 0) {
      throw new Error(`--to "${shown}" matches only inactive participants: ${participantCandidates(inactive)}. Active participants: ${participantCandidates(active)}.`);
    }
    throw new Error(`--to "${shown}" matches no participant. Active participants: ${participantCandidates(active)}.`);
  }
  if (ids.size > MAX_COLLABORATION_RECIPIENTS) {
    throw new Error(`--to may address at most ${MAX_COLLABORATION_RECIPIENTS} participants.`);
  }
  return [...ids].sort();
}

/** Labels for rendering recipients, keyed by lowercase participant ID. */
export function collaborationParticipantLabels(data: CollaborationResponse): CollaborationParticipantLabels {
  const labels = new Map<string, string>();
  for (const participant of collaborationRecords(data.participants)) {
    if (typeof participant.id === 'string') labels.set(participant.id.toLowerCase(), actorLabel(participant.actor));
  }
  return labels;
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

/**
 * `to: <label>, <label>` for an addressed event, or empty for a room-wide one.
 * A missing `recipientParticipantIds` (an older server) means room-wide.
 * Recipients without a known label are shown by participant ID.
 */
function eventRecipientSummary(
  event: CollaborationResponse,
  labels?: CollaborationParticipantLabels,
): string {
  const ids = Array.isArray(event.recipientParticipantIds)
    ? event.recipientParticipantIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length === 0) return '';
  return `to: ${ids.map((id) => labels?.get(id.toLowerCase()) ?? sanitizeTerminalLine(id)).join(', ')}`;
}

/** One redacted, terminal-safe line for a ledger event. */
export function renderCollaborationEventLine(
  event: CollaborationResponse,
  labels?: CollaborationParticipantLabels,
): string {
  const preview = eventTextPreview(event) || eventReferenceSummary(event) || '—';
  const recipients = eventRecipientSummary(event, labels);
  return [
    `#${sanitizeTerminalLine(event.sequence ?? '?')}`,
    sanitizeTerminalLine(event.kind ?? 'unknown'),
    actorLabel(event.actor),
    ...(recipients ? [recipients] : []),
    preview,
  ].join('  ');
}

export function renderCollaborationEvents(
  data: CollaborationResponse,
  options: CollaborationEventsRenderOptions = {},
): string {
  const events = collaborationRecords(data.events);
  const serverPageLastSequence = Number.isSafeInteger(data.nextSequence) && Number(data.nextSequence) >= 0
    ? Number(data.nextSequence)
    : null;
  const deliveredSequences = events.map((event) => event.sequence);
  const deliveredSequence = events.length > 0
    && deliveredSequences.every((sequence) => Number.isSafeInteger(sequence) && Number(sequence) >= 0)
    ? Math.max(...deliveredSequences.map(Number))
    : null;
  // With audience 'me' the watermark is the highest sequence the server examined,
  // so acknowledging it also skips the events filtered out for the caller. It is used
  // only when it does not trail the delivered events.
  const forMeWatermark = options.forMe === true
    && serverPageLastSequence !== null
    && (deliveredSequence === null ? events.length === 0 : serverPageLastSequence >= deliveredSequence)
    ? serverPageLastSequence
    : null;
  const acknowledgeSequence = forMeWatermark ?? deliveredSequence;
  const lines = events.map((event) => renderCollaborationEventLine(event, options.labels));
  if (events.length === 0) lines.push(data.timedOut === true ? 'Wait timed out with no events.' : 'No collaboration events found.');
  if (typeof data.consumerKey === 'string') lines.push(`Consumer: ${sanitizeTerminalLine(data.consumerKey)}`);
  if (serverPageLastSequence !== null) lines.push(`Server page watermark: ${serverPageLastSequence}`);
  if (typeof data.consumerKey === 'string' && acknowledgeSequence !== null) {
    const workItemId = events[0]?.workItemId ?? options.workItemId ?? '<work-item-id>';
    lines.push(events.length > 0
      ? 'Cursor was not acknowledged. After durable processing, run:'
      : 'Cursor was not acknowledged. To skip the events filtered out by --for-me, run:');
    lines.push(
      `sift work collaboration acknowledge ${sanitizeTerminalLine(workItemId)} --consumer-key ${sanitizeTerminalLine(data.consumerKey)} --last-sequence ${acknowledgeSequence}`,
    );
    if (events.length > 0 && forMeWatermark !== null && forMeWatermark !== deliveredSequence) {
      lines.push('That sequence also covers the events filtered out by --for-me.');
    }
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

export function renderCollaborationEventMutation(
  data: CollaborationResponse,
  labels?: CollaborationParticipantLabels,
): string {
  const event = collaborationData(data.event);
  const sent = `Sent event: #${sanitizeTerminalLine(event.sequence ?? '?')} ${sanitizeTerminalLine(event.kind ?? 'unknown')} ${eventTextPreview(event)}`.trim();
  const recipients = eventRecipientSummary(event, labels);
  return recipients ? `${sent}\n${recipients}` : sent;
}

export function renderCollaborationCursor(data: CollaborationResponse): string {
  const cursor = collaborationData(data.cursor);
  return `Acknowledged ${sanitizeTerminalLine(cursor.consumerKey ?? 'unknown')} through exact sequence ${sanitizeTerminalLine(cursor.lastSequence ?? '?')}.`;
}
