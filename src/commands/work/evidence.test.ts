import {describe, expect, it, vi} from 'vitest';
import WorkEvidence, {describePatch} from './evidence.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const patch = {sha256: 'a'.repeat(64), bytes: 120, fileCount: 2, truncated: false, withheld: null, retainedSha256: 'a'.repeat(64), retainedBytes: 120, complete: true};
const evidence = (result: unknown) => ({
  version: 1, workItemId: 'work-1',
  attempt: {id: 'attempt-1', state: 'ended', endReason: 'terminated', harness: 'codex', model: 'gpt-6.1', host: 'mbp', startedAt: '2026-10-18T10:00:00Z', endedAt: '2026-10-18T10:05:00Z'},
  result,
  decisions: {requests: [{kind: 'approval', summary: 'Run tests', state: 'resolved', resolution: {decision: 'acceptForSession'}, resolvedAt: '2026-10-18T10:01:00Z', deliveryState: 'delivered'}], truncated: false},
  verification: {
    attempt: {attempts: [{outcome: 'passed', attemptId: 'taster-abc', ranAt: '2026-10-18T10:06:00Z'}], truncated: false},
    workItem: {attempts: [{outcome: 'failed', attemptId: 'manual-1', ranAt: '2026-10-17T09:00:00Z'}], truncated: true},
  },
  effects: {
    completed: [{effectKey: 'checkpoint/1', domain: 'workspace_checkpoint', state: 'confirmed', settlement: null}],
    unfinished: [],
    inFlight: [],
    uncertain: [{effectKey: 'patch/1', domain: 'workspace_patch', state: 'dispatching', settlement: null}],
    truncated: false,
  },
  input: {
    accepted: {workItemRevision: 3, payloadSha256: 'ab'.repeat(32), payloadBytes: 812},
    resume: {fromAttemptId: 'attempt-0', status: 'changed'},
  },
});

async function runWith(body: unknown, json: boolean) {
  const evidenceCommand = command(WorkEvidence);
  const apiRequest = vi.fn().mockResolvedValue(body);
  const log = vi.fn();
  (evidenceCommand as any).parse = vi.fn().mockResolvedValue({args: {id: 'work/1'}, flags: {attempt: 'attempt 1'}});
  (evidenceCommand as any).apiRequest = apiRequest;
  (evidenceCommand as any).jsonEnabled = () => json;
  (evidenceCommand as any).log = log;
  const result = await evidenceCommand.run();
  return {result, apiRequest, lines: log.mock.calls.map(([line]) => line as string)};
}

describe('work evidence', () => {
  it('reads one attempt from the server only and returns the body unchanged in JSON mode', async () => {
    const body = evidence({status: 'recorded', record: {recordedAt: '2026-10-18T10:04:00Z', payloadSha256: 'b'.repeat(64)}, patch});
    const {result, apiRequest, lines} = await runWith(body, true);
    expect(apiRequest).toHaveBeenCalledWith({attempt: 'attempt 1'}, '/api/v1/work-items/work%2F1/execution-attempts/attempt%201/evidence');
    expect(result).toEqual(body);
    expect(lines).toEqual([]);
  });

  it('states a missing result plainly as final', async () => {
    const {lines} = await runWith(evidence({status: 'missing'}), false);
    expect(lines).toContain('Result: MISSING. The attempt is no longer live and recorded no result; it cannot record one now.');
    expect(lines).toContain('  approval · Run tests · acceptForSession at 2026-10-18T10:01:00Z · delivery delivered');
    expect(lines).toContain('Verification of this attempt: 1');
    expect(lines).toContain('  passed · taster-abc · 2026-10-18T10:06:00Z');
    expect(lines).toContain('Unbound work-item verification (not tied to any attempt): 1 (older ones not shown)');
    expect(lines).toContain('Effects: 1 completed, 0 unfinished, 0 in flight, 1 uncertain');
    expect(lines).toContain('  UNCERTAIN: patch/1 · workspace_patch · dispatching');
    expect(lines).toContain('Accepted input: revision 3 · 812 bytes · sha256 abababababab');
    expect(lines).toContain('  Resumed from attempt-0: input changed');
  });

  it('prints no effects or input line for a server that predates them', async () => {
    const {effects: _effects, input: _input, ...older} = evidence({status: 'pending'});
    const {lines} = await runWith(older, false);
    expect(lines.some((line) => line.startsWith('Effects:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Accepted input:'))).toBe(false);
  });

  it('says a live attempt\'s result is pending', async () => {
    const {lines} = await runWith(evidence({status: 'pending'}), false);
    expect(lines).toContain('Result: pending; the attempt is still live and may record one.');
  });
});

describe('patch description', () => {
  it('describes a complete patch with its hash', () => {
    expect(describePatch(patch)).toBe(`complete, 120 bytes, 2 files, sha256 ${'a'.repeat(64)}`);
  });

  it('never presents a cut patch as whole', () => {
    expect(describePatch({...patch, truncated: true, complete: false, retainedBytes: 60, retainedSha256: 'c'.repeat(64)}))
      .toBe(`INCOMPLETE: cut to fit the 64 KiB result limit. Retained 60 of 120 bytes; whole diff sha256 ${'a'.repeat(64)}, retained ${'c'.repeat(64)}`);
  });

  it('names why a patch was withheld', () => {
    expect(describePatch({...patch, withheld: 'possible_credential', complete: false, retainedBytes: 0})).toMatch(/^INCOMPLETE: withheld \(possible_credential\)\./);
  });
});
