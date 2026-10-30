/**
 * The supervisor's handler for the sidecar's routes during an attempt
 * (first-run U2d-2). The diagnostic route proves readiness before the
 * dispatch is acknowledged. The model routes stay closed (503) until the
 * supervisor opens them after a positive acknowledgement, then forward to the
 * attempt-bound relay on the API with the credential, claim, role and a
 * journaled call ID that only the supervisor holds. A call whose delivery is
 * unknown is never retried; the agent sees the failure.
 */
import {QUESTION_PATHS, type QuestionDesk} from './attemptQuestions.js';
import {DIAGNOSTIC_PATH, MODEL_PATHS} from './relaySidecar.js';
import type {SidecarHandler} from './sidecarBridge.js';

export interface ModelRelayTarget {
  apiUrl: string;
  token: string;
  workspaceId: string | null;
  workItemId: string;
  attemptId: string;
  claimToken: string;
  /**
   * The relay role the API charges the call to (U3-2): the writer by default; the reviewer's sidecar only reaches the
   * OpenAI Responses route (Taster's codexClient) and never the writer's questions.
   */
  role?: 'writer' | 'reviewer';
}

export interface ModelRelayControl {
  /** True once the dispatch is positively acknowledged and the workload released. */
  open(): boolean;
  /** The next call's durable ID, journaled before it is returned. */
  nextCallId(): Promise<string>;
  /** Needs you: the writer's questions, open with the model routes. */
  questions?: QuestionDesk;
  /**
   * Told of every forwarded call (U3-2 review provenance): its key, the relay's status (0 when delivery is unknown) and
   * the API's call ID from `x-sift-call-id`, so the record can be joined to the budget ledger.
   */
  recorded?: (call: {key: string; status: number; callId?: string}) => Promise<void> | void;
}

const UPSTREAM: Record<string, string> = {
  [MODEL_PATHS.anthropic]: 'model/anthropic/v1/messages',
  [MODEL_PATHS.openai]: 'model/openai/v1/responses',
};

const json = (status: number, detail: string) => ({status, body: JSON.stringify({error: {type: 'sift_relay', message: detail}})});

export function attemptRelayHandler(
  deps: {fetch: typeof fetch; diagnosticNonce: string},
  target: ModelRelayTarget,
  control: ModelRelayControl,
): SidecarHandler {
  return async (frame, signal) => {
    if (frame.method === 'GET' && frame.path === DIAGNOSTIC_PATH) {
      return {status: 200, body: JSON.stringify({nonce: deps.diagnosticNonce})};
    }
    const reviewer = target.role === 'reviewer';
    if (frame.method === 'POST' && (Object.values(QUESTION_PATHS) as string[]).includes(frame.path)) {
      if (reviewer) return {status: 404, body: ''};
      if (!control.questions || !control.open()) return json(503, 'The attempt is not running; questions are closed.');
      return control.questions.handle(frame.path, Buffer.from(frame.body, 'base64').toString('utf8'), signal);
    }
    const upstream = frame.method === 'POST' && (!reviewer || frame.path === MODEL_PATHS.openai) ? UPSTREAM[frame.path] : undefined;
    if (!upstream) return {status: 404, body: ''};
    if (!control.open()) return json(503, 'The attempt has not started; model calls are closed.');
    const callId = await control.nextCallId();
    let response: Response;
    try {
      response = await deps.fetch(
        `${target.apiUrl}/api/v1/work-items/${target.workItemId}/execution-attempts/${target.attemptId}/${upstream}`, {
          method: 'POST', redirect: 'error', signal,
          headers: {
            'Authorization': `Bearer ${target.token}`,
            'Content-Type': 'application/json',
            'X-Sift-Claim-Token': target.claimToken,
            'X-Sift-Model-Role': reviewer ? 'reviewer' : 'writer',
            'Idempotency-Key': callId,
            ...(target.workspaceId ? {'X-Workspace-Id': target.workspaceId} : {}),
          },
          body: Buffer.from(frame.body, 'base64'),
        });
    } catch {
      // Delivery is unknown; retrying could charge twice.
      await control.recorded?.({key: callId, status: 0});
      return json(502, 'The model call could not be confirmed and was not retried.');
    }
    const apiCallId = response.headers.get('x-sift-call-id') ?? undefined;
    await control.recorded?.({key: callId, status: response.status, ...(apiCallId ? {callId: apiCallId} : {})});
    if (!response.ok || !response.body) {
      // Relay refusals (stopped attempt, allowance, duplicate key) carry no key material; pass their status on.
      return {status: response.status, body: Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))};
    }
    return {status: response.status, stream: response.body as unknown as AsyncIterable<Uint8Array>};
  };
}
