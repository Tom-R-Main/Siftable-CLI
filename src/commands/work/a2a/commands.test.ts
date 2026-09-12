import {describe, expect, it, vi} from 'vitest';
import Send from './send.js';
import Continue from './continue.js';
import Cancel from './cancel.js';
import Recover from './recover.js';
import Review from './review.js';

function prepare<T extends {run(): Promise<unknown>}>(constructor: {prototype: T}, args: unknown, flags: unknown) {
  const command = Object.create(constructor.prototype) as T & {
    parse: unknown; apiRequest: ReturnType<typeof vi.fn>; jsonEnabled: unknown;
  };
  command.parse = vi.fn().mockResolvedValue({args, flags});
  command.apiRequest = vi.fn().mockResolvedValue({ok: true});
  command.jsonEnabled = () => true;
  return command;
}

describe('addressed A2A operations', () => {
  it('binds exact remote personal scope, bounds and replay key', async () => {
    const command = prepare(Send, {connection: 'connection', work: 'local-work'},
      {text: 'assignment', 'remote-work': 'remote-work', 'max-turns': 3, deadline: '2026-09-12T12:00:00Z', 'request-key': 'stable'});
    await command.run();
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/a2a-connections/connection/dispatches', {
      method: 'POST', idempotencyKey: 'stable', body: {workItemId: 'local-work', text: 'assignment',
        remoteTarget: {workItemId: 'remote-work', workspaceId: null}, bounds: {maxTurns: 3, deadline: '2026-09-12T12:00:00Z'}},
    });
  });
  it('addresses clarification to one dispatch with a replay key', async () => {
    const command = prepare(Continue, {connection: 'c', dispatch: 'd'}, {text: 'answer', 'request-key': 'replay'});
    await command.run();
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/a2a-connections/c/dispatches/d/messages',
      {method: 'POST', body: {text: 'answer'}, idempotencyKey: 'replay'});
  });
  it('does not claim worker termination from conversation cancellation', async () => {
    expect(Cancel.description).toContain('worker termination remains unconfirmed');
    const command = prepare(Cancel, {connection: 'c', dispatch: 'd'}, {});
    await command.run();
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/a2a-connections/c/dispatches/d/cancel', {method: 'POST'});
  });
  it('passes the observed generation for recovery', async () => {
    const command = prepare(Recover, {connection: 'c', dispatch: 'd'}, {generation: 4});
    await command.run();
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/a2a-connections/c/dispatches/d/recover', {method: 'POST', body: {generation: 4}});
  });
  it('reads the review without executing verification', async () => {
    const command = prepare(Review, {id: 'work'}, {});
    await command.run();
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/work-items/work/a2a/review');
  });
});
