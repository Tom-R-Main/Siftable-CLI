import {describe, expect, it} from 'bun:test';
import {digestJson, SessionKernel, type SessionEvent} from '../agent-harness/framework/session';
import {formatSessionInspection, inspectSessionEvents} from '../requestInspection';

function prepared(envelope = true) {
  const session = new SessionKernel({sessionId: 'inspection-fixture'});
  session.replaceHistory([{role: 'user', content: 'Older source evidence'}, {role: 'assistant', content: 'Earlier answer'}], 'imported');
  const compacted = session.replaceHistory([{role: 'user', content: 'Compacted summary'}], 'compaction_applied');
  const context = {turnId: 'turn', stepId: 'step'};
  session.append({type: 'turn/started', data: {}, turnId: context.turnId});
  session.appendMessage({role: 'user', content: 'New request'}, {turnId: context.turnId});
  session.append({type: 'step/started', data: {}, ...context});
  const request = session.append({type: 'model/request-prepared', data: {
    ...(envelope ? {envelope: {systemPrompt: 'System fixture', tools: []}} : {}),
    history: {throughSeq: session.getEventCount(), messageCount: session.getHistory().length, sha256: digestJson(session.getHistory())},
    systemPromptSha256: digestJson('System fixture'), tools: {names: [], sha256: digestJson([])},
    adapter: {name: 'fixture-provider', model: 'fixture-model'}, options: {temperature: 0},
  }, ...context});
  session.append({type: 'model/response-received', data: {text: 'Later reply'}, ...context});
  session.appendMessage({role: 'assistant', content: 'Later reply'}, context);
  session.append({type: 'step/completed', data: {outcome: 'completed'}, ...context});
  session.append({type: 'turn/completed', data: {finalText: 'Later reply'}, turnId: context.turnId});
  return {session, request, compacted};
}

describe('request inspection', () => {
  it('reconstructs the exact request history before later assistant messages', () => {
    const {session, request} = prepared();
    const before = JSON.stringify(session.getEvents());
    const inspection = inspectSessionEvents(session.getEvents(), session.getHistory());
    expect(inspection.latestRequest?.seq).toBe(request.seq);
    expect(inspection.latestRequest?.history).toEqual([{role: 'user', content: 'Compacted summary'}, {role: 'user', content: 'New request'}]);
    expect(inspection.latestRequest?.historyVerified).toBe(true);
    expect(inspection.latestRequest?.recoverable).toBe(true);
    expect(inspection.projectionVerified).toBe(true);
    expect(inspection.recentTerminal?.type).toBe('turn/completed');
    expect(JSON.stringify(session.getEvents())).toBe(before);
  });

  it('records compaction counts and prior sequence references', () => {
    const {session, compacted} = prepared();
    const inspection = inspectSessionEvents(session.getEvents(), session.getHistory());
    expect(inspection.replacements.find(item => item.seq === compacted.seq)).toMatchObject({compaction: true, beforeMessages: 2, afterMessages: 1, sourceFromSeq: 2, sourceThroughSeq: 2});
    expect(formatSessionInspection(inspection)).toContain('1 compactions');
    expect(formatSessionInspection(inspection)).toContain('prior projection sources #2–#2');
  });

  it('labels legacy snapshots as incomplete while verifying their history', () => {
    const {session} = prepared(false);
    const inspection = inspectSessionEvents(session.getEvents(), session.getHistory());
    expect(inspection.latestRequest?.historyVerified).toBe(true);
    expect(inspection.latestRequest?.recoverable).toBe(false);
    expect(formatSessionInspection(inspection, 'request')).toContain('full request unavailable');
  });

  it('flags a stale caller projection instead of presenting it as verified', () => {
    const {session} = prepared();
    expect(inspectSessionEvents(session.getEvents(), []).projectionVerified).toBe(false);
  });

  it('rejects a tampered history digest through the kernel validator', () => {
    const {session, request} = prepared();
    const events = structuredClone(session.getEvents()) as SessionEvent[];
    const candidate = events.find(event => event.seq === request.seq)!;
    if (candidate.type === 'model/request-prepared') candidate.data.history.sha256 = '0'.repeat(64);
    expect(() => inspectSessionEvents(events, session.getHistory())).toThrow('history digest');
  });

  it('labels truncated request displays and retains source references', () => {
    const {session} = prepared();
    const inspection = structuredClone(inspectSessionEvents(session.getEvents(), session.getHistory()));
    inspection.latestRequest!.history = [{role: 'user', content: 'x'.repeat(20_000)}];
    const display = formatSessionInspection(inspection, 'request');
    expect(display).toContain('[truncated display:');
    expect(display.length).toBeLessThan(16_300);
    expect(display).toContain(`history through #${inspection.latestRequest!.throughSeq}`);
  });

  it('bounds recent event displays and labels omission', () => {
    const session = new SessionKernel({sessionId: 'long-inspection'});
    for (let i = 0; i < 45; i++) session.replaceHistory([], 'fixture');
    const inspection = inspectSessionEvents(session.getEvents(), []);
    expect(inspection.recentEvents).toHaveLength(40);
    expect(formatSessionInspection(inspection, 'events')).toContain('showing 40 of 46 (older events omitted');
  });

  it('supports an empty session without creating events', () => {
    const inspection = inspectSessionEvents([], []);
    expect(inspection.latestRequest).toBeNull();
    expect(inspection.projectionVerified).toBe(true);
    expect(formatSessionInspection(inspection, 'request')).toBe('No recorded model request yet.');
  });

  it('preserves tool output references without opening them', () => {
    const session = new SessionKernel({sessionId: 'output-inspection'});
    const context = {turnId: 'turn', stepId: 'step'};
    const call = {id: 'call', name: 'read_file', args: {path: 'fixture'}};
    session.append({type: 'turn/started', data: {}, turnId: 'turn'});
    session.append({type: 'step/started', data: {}, ...context});
    session.append({type: 'model/request-prepared', data: {
      history: {throughSeq: session.getEventCount(), messageCount: 0, sha256: digestJson([])},
      systemPromptSha256: digestJson('fixture'), tools: {names: ['read_file'], sha256: digestJson([])},
    }, ...context});
    session.append({type: 'model/response-received', data: {toolCall: call}, ...context});
    session.appendMessage({role: 'assistant', content: JSON.stringify(call.args), toolCallId: call.id, toolName: call.name}, context);
    session.append({type: 'tool/call', data: {call}, ...context});
    session.append({type: 'tool/execution-started', data: {call}, ...context});
    const output = session.append({type: 'tool/result', data: {toolCallId: call.id, toolName: call.name, outcome: 'succeeded', modelContent: 'bounded excerpt', output: {truncated: true, byteCount: 20000, lineCount: 300, fullOutputRef: '/nonexistent/inspection-must-not-open'}}, ...context});
    const inspection = inspectSessionEvents(session.getEvents(), session.getHistory());
    expect(inspection.retainedOutputs).toEqual([{seq: output.seq, toolName: 'read_file', toolCallId: 'call', fullOutputRef: '/nonexistent/inspection-must-not-open', byteCount: 20000, lineCount: 300}]);
    expect(formatSessionInspection(inspection)).toContain(`Evidence #${output.seq} read_file: 20000 bytes`);
  });
});
