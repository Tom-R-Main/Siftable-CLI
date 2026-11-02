import type {ChatMessage} from './agent-harness/framework/adapters/types';
import {
  digestJson,
  SessionKernel,
  snapshotJson,
  type ModelRequestSnapshot,
  type SessionEvent,
  type SessionEventType,
} from './agent-harness/framework/session';

export interface SessionInspection {
  eventCount: number;
  messageCount: number;
  projectionVerified: boolean;
  latestRequest: {
    seq: number;
    throughSeq: number;
    snapshot: Readonly<ModelRequestSnapshot>;
    history: readonly ChatMessage[];
    historyVerified: boolean;
    recoverable: boolean;
  } | null;
  verifications?: Array<{seq: number; receipt: import('./candidateVerification').CandidateVerificationReceipt; current?: boolean; freshnessReason?: string}>;
  auxiliaryRequests?: Array<{seq: number; correlationId: string; purpose: string; snapshot: ModelRequestSnapshot; input: readonly ChatMessage[]; verified: boolean}>;
  recentTerminal: {seq: number; type: SessionEventType; data: unknown} | null;
  replacements: Array<{
    seq: number;
    reason: string;
    compaction: boolean;
    beforeMessages: number;
    afterMessages: number;
    sourceFromSeq: number;
    sourceThroughSeq: number;
  }>;
  retainedOutputs: Array<{
    seq: number;
    toolName: string;
    toolCallId: string;
    fullOutputRef?: string;
    byteCount: number;
    lineCount: number;
  }>;
  recentEvents: Array<{seq: number; type: SessionEventType; turnId?: string; stepId?: string}>;
}

/** Reuse the kernel's validated projection; this store never reads or writes files. */
export function projectSessionHistory(events: readonly SessionEvent[]): readonly ChatMessage[] {
  if (!events.length) return [];
  return new SessionKernel({
    sessionId: events[0]!.sessionId,
    store: {
      read: () => events,
      append: () => { throw new Error('Inspection cannot append session events.'); },
    },
  }).getHistory();
}

export function inspectSessionEvents(
  events: readonly SessionEvent[],
  projectedHistory: readonly ChatMessage[],
): SessionInspection {
  const history = projectSessionHistory(events);
  const request = [...events].reverse().find(event => event.type === 'model/request-prepared');
  const terminal = [...events].reverse().find(event => ['turn/completed', 'turn/failed', 'turn/interrupted'].includes(event.type));
  let latestRequest: SessionInspection['latestRequest'] = null;
  if (request?.type === 'model/request-prepared') {
    const snapshot = request.data;
    const prior = projectSessionHistory(events.filter(event => event.seq <= snapshot.history.throughSeq));
    const historyVerified = snapshot.history.throughSeq === request.seq - 1
      && prior.length === snapshot.history.messageCount
      && digestJson(prior) === snapshot.history.sha256;
    latestRequest = {
      seq: request.seq, throughSeq: snapshot.history.throughSeq, snapshot, history: prior, historyVerified,
      recoverable: historyVerified && snapshot.envelope !== undefined
        && digestJson(snapshot.envelope.systemPrompt) === snapshot.systemPromptSha256
        && digestJson(snapshot.envelope.tools) === snapshot.tools.sha256,
    };
  }
  const replacements: SessionInspection['replacements'] = [];
  const retainedOutputs: SessionInspection['retainedOutputs'] = [];
  let messageCount = 0;
  let sourceFromSeq = 1;
  for (const event of events) {
    if (event.type === 'session/started' || event.type === 'session/reset') {
      messageCount = 0;
      sourceFromSeq = event.seq;
    } else if (event.type === 'message/appended') {
      messageCount++;
    } else if (event.type === 'history/replaced') {
      replacements.push({
        seq: event.seq, reason: event.data.reason ?? 'unspecified',
        compaction: event.data.reason === 'compaction_applied',
        beforeMessages: messageCount, afterMessages: event.data.history.length,
        sourceFromSeq, sourceThroughSeq: event.seq - 1,
      });
      messageCount = event.data.history.length;
      sourceFromSeq = event.seq;
    } else if (event.type === 'tool/result' && event.data.output) {
      retainedOutputs.push({
        seq: event.seq, toolName: event.data.toolName, toolCallId: event.data.toolCallId,
        fullOutputRef: event.data.output.fullOutputRef,
        byteCount: event.data.output.byteCount, lineCount: event.data.output.lineCount,
      });
    }
  }
  return snapshotJson({
    eventCount: events.length,
    messageCount: projectedHistory.length,
    projectionVerified: digestJson(history) === digestJson(projectedHistory),
    latestRequest,
    verifications: events.filter(event => event.type === 'verification/recorded').map(event => ({seq: event.seq, receipt: (event as import('./agent-harness/framework/session').SessionEventOf<'verification/recorded'>).data.receipt})),
    auxiliaryRequests: events.filter(event => event.type === 'model/auxiliary-request-prepared').map(event => {
      if (event.type !== 'model/auxiliary-request-prepared') throw new Error('unexpected auxiliary request');
      const {input, inputSha256, purpose, ...snapshot} = event.data;
      return {seq: event.seq, correlationId: event.correlationId!, purpose, snapshot, input,
        verified: digestJson(input) === inputSha256 && Boolean(snapshot.envelope)
          && digestJson(snapshot.envelope!.systemPrompt) === snapshot.systemPromptSha256
          && digestJson(snapshot.envelope!.tools) === snapshot.tools.sha256};
    }),
    recentTerminal: terminal ? {seq: terminal.seq, type: terminal.type, data: terminal.data} : null,
    replacements,
    retainedOutputs,
    recentEvents: events.slice(-40).map(({seq, type, turnId, stepId}) => ({seq, type, turnId, stepId})),
  }) as SessionInspection;
}

export function formatSessionInspection(inspection: SessionInspection, part: 'summary' | 'request' | 'events' = 'summary'): string {
  if (part === 'request') {
    if (!inspection.latestRequest) return 'No recorded model request yet.';
    const request = inspection.latestRequest;
    const json = JSON.stringify({
      seq: request.seq, throughSeq: request.throughSeq, historyVerified: request.historyVerified,
      recoverable: request.recoverable, ...request.snapshot, messages: request.history,
      auxiliaryRequests: inspection.auxiliaryRequests,
    }, null, 2);
    const body = json.length > 16_000
      ? `${json.slice(0, 16_000)}\n[truncated display: ${json.length} characters total; request #${request.seq}, history through #${request.throughSeq}]`
      : json;
    return `Request #${request.seq} · ${request.recoverable ? 'recorded envelope and history verified' : 'full request unavailable or unverified'}\n${body}`;
  }
  if (part === 'events') {
    return [
      `Journal events: showing ${inspection.recentEvents.length} of ${inspection.eventCount}${inspection.eventCount > inspection.recentEvents.length ? ' (older events omitted from display)' : ''}`,
      ...inspection.recentEvents.map(event => `#${event.seq} ${event.type}${event.turnId ? ` · turn ${event.turnId}` : ''}${event.stepId ? ` · step ${event.stepId}` : ''}`),
    ].join('\n');
  }
  const request = inspection.latestRequest;
  return [
    `Context: ${inspection.messageCount} messages · ${inspection.eventCount} journal events · projection ${inspection.projectionVerified ? 'verified' : 'mismatch'}`,
    request ? `Latest request #${request.seq}: history through #${request.throughSeq} · ${request.snapshot.adapter?.name ?? 'unknown provider'}/${request.snapshot.adapter?.model ?? 'unknown model'} · ${request.recoverable ? 'recoverable' : 'full request unavailable or unverified'}` : 'No recorded model request yet.',
    inspection.recentTerminal ? `Latest terminal #${inspection.recentTerminal.seq}: ${inspection.recentTerminal.type}` : 'No recorded terminal turn yet.',
    ...(inspection.verifications || []).slice(-5).map(item => `Verification #${item.seq}: recorded ${item.receipt.status} · ${item.receipt.files.length} explicit files · ${item.current === true ? 'candidate still matches' : item.current === false ? item.freshnessReason || 'candidate no longer verified' : 'current files not checked'}`),
    `${inspection.auxiliaryRequests?.length ?? 0} recorded compaction requests`,
    `${inspection.replacements.filter(item => item.compaction).length} compactions · ${inspection.replacements.length} history replacements · ${inspection.retainedOutputs.length} truncated tool outputs`,
    ...inspection.replacements.slice(-5).map(item => `#${item.seq} ${item.reason}: ${item.beforeMessages} → ${item.afterMessages} messages; prior projection sources #${item.sourceFromSeq}–#${item.sourceThroughSeq}`),
    ...(inspection.replacements.length > 5 ? [`[showing latest 5 of ${inspection.replacements.length} replacements]`] : []),
    ...inspection.retainedOutputs.slice(-5).map(item => `Evidence #${item.seq} ${item.toolName}: ${item.byteCount} bytes, ${item.lineCount} lines; ${item.fullOutputRef ? 'full-output reference retained' : 'full output unavailable'}`),
    ...(inspection.retainedOutputs.length > 5 ? [`[showing latest 5 of ${inspection.retainedOutputs.length} output references]`] : []),
    '/context request shows the recorded request; /context events shows recent sequence references.',
  ].join('\n');
}
