import {describe, expect, test} from 'bun:test';
import {SessionKernel} from '../agent-harness/framework/session';

const receipt = {requestId: 'request', provider: 'Meta', requestedModel: 'requested', attempts: 1, mode: 'buffered', outcome: 'completed', usage: {inputTokens: 3}};
describe('durable provider receipt schema', () => {
  for (const invalid of [
    {type: 'provider.response'},
    {type: 'provider.response', receipt: {...receipt, requestId: ''}},
    {type: 'provider.response', receipt: {...receipt, attempts: -1}},
    {type: 'provider.response', receipt: {...receipt, attempts: 0}},
    {type: 'provider.response', receipt: {...receipt, mode: 'pretend'}},
    {type: 'provider.response', receipt: {...receipt, outcome: 'maybe'}},
    {type: 'provider.response', receipt: {...receipt, error: {code: 'gateway_attempt_limit', retryable: false}}},
    {type: 'provider.response', receipt: {...receipt, outcome: 'failed', error: {code: 'gateway_attempt_limit', retryable: true}}},
    {type: 'provider.response', receipt: {...receipt, outcome: 'failed', error: {code: 'untrusted body text', retryable: false}}},
    {type: 'provider.response', receipt: {...receipt, outcome: 'failed', error: {code: 'gateway_attempt_limit', retryable: false, body: 'private'}}},
    {type: 'provider.response', receipt: {...receipt, usage: {inputTokens: -3}}},
    {type: 'provider.response', receipt: {...receipt, usage: {outputTokens: 1.5}}},
    {type: 'provider.retry', requestId: 'request', attempt: 1, status: 429, delayMs: -1},
    {type: 'provider.attempt', requestId: 'request', attempt: 1, provider: 'Meta', requestedModel: 'requested', mode: 'streaming'},
  ]) test(`rejects malformed evidence ${JSON.stringify(invalid)}`, () => {
    const session = new SessionKernel({sessionId: 'schema'});
    expect(() => session.append({type: 'model/provider-event', data: {event: invalid as never}})).toThrow();
    expect(session.getEventCount()).toBe(1);
  });
  test('accepts observed receipts and cancellation before HTTP admission', () => {
    const session = new SessionKernel({sessionId: 'schema-valid'});
    session.append({type: 'model/provider-event', data: {event: {type: 'provider.response', receipt: receipt as never}}});
    session.append({type: 'model/provider-event', data: {event: {type: 'provider.response', receipt: {...receipt, attempts: 0, outcome: 'cancelled'} as never}}});
    session.append({type: 'model/provider-event', data: {event: {type: 'provider.response', receipt: {...receipt, outcome: 'failed', error: {code: 'gateway_attempt_limit', retryable: false}} as never}}});
    expect(session.getEventCount()).toBe(4);
  });
});
