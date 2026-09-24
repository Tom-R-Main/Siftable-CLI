import {describe, expect, it, vi} from 'vitest';
import WorkVerify from './verify.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('work verify retirement boundary', () => {
  it('returns a deterministic retirement notice without contacting the API or a model', async () => {
    const verify = command(WorkVerify);
    const client = vi.fn();
    (verify as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'work-1'},
      flags: {history: false, reps: 5, model: 'any-model'},
    });
    (verify as any).client = client;
    (verify as any).jsonEnabled = () => true;

    const result = await verify.run();

    expect(client).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'retired',
      workItemId: 'work-1',
      message: 'Hosted LLM work verification has been retired and no model was invoked.',
      authoritativeGate: 'commands_passed',
      next: 'Submit immutable verification-command evidence with `sift work verification evidence`.',
      historyCommand: 'sift work verify work-1 --history',
    });
  });

  it('keeps historical verifier runs readable with --history', async () => {
    const verify = command(WorkVerify);
    const runs = [{createdAt: '2026-01-01T00:00:00.000Z', verdict: 'pass'}];
    const listWorkItemVerifierRuns = vi.fn().mockResolvedValue({data: {runs}});
    const verifyWorkItem = vi.fn();
    (verify as any).parse = vi.fn().mockResolvedValue({args: {id: 'work-1'}, flags: {history: true}});
    (verify as any).client = vi.fn().mockResolvedValue({listWorkItemVerifierRuns, verifyWorkItem});
    (verify as any).handleApiError = vi.fn();
    (verify as any).jsonEnabled = () => true;

    const result = await verify.run();

    expect(listWorkItemVerifierRuns).toHaveBeenCalledWith('work-1');
    expect(verifyWorkItem).not.toHaveBeenCalled();
    expect(result).toEqual(runs);
  });
});
