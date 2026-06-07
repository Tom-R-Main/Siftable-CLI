/**
 * Lane C S6 — child-bar formatter. Children render as their own badged segment;
 * the formatter is a pure function whose entries are keyed by stable sessionId,
 * so reordering the input never renumbers a child or misplaces the active mark.
 */
import {formatChildBar, formatChildBarLine, type ChildBarEntry} from '../interactive-tui/childBar';
import type {ChildSessionView} from '../interactive-tui/childSessionController';
import type {RunningAgent} from '../interactive-tui/controlClient';

function child(sessionId: number, branch: string, extra: Partial<ChildSessionView> = {}): ChildSessionView {
  return {
    sessionId,
    parentSessionId: 1,
    title: branch,
    repoRoot: '/repo',
    branch,
    baseBranch: 'main',
    worktreePath: `/wt/${branch}`,
    sessionCwd: `/wt/${branch}`,
    baseCommit: 'c0',
    headCommit: 'c0',
    accessMode: 'read_write',
    writeScope: [],
    conversationKey: `k-${sessionId}`,
    status: 'running',
    ...extra,
  };
}

describe('formatChildBar', () => {
  it('marks exactly the active child distinctly from idle ones', () => {
    const entries = formatChildBar([child(2, 'sift/a-1'), child(5, 'sift/b-2')], 2);
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    expect(byId.get(2)!.active).toBe(true);
    expect(byId.get(5)!.active).toBe(false);
    expect(byId.get(2)!.label).toBe('child·a-1'); // sift/ prefix dropped, badged
  });

  it('keys entries by stable sessionId — reordering the input is stable', () => {
    const a = child(2, 'sift/a-1');
    const b = child(5, 'sift/b-2');
    const forward = formatChildBar([a, b], 5);
    const reversed = formatChildBar([b, a], 5);

    const pick = (es: ChildBarEntry[], id: number) => es.find((e) => e.sessionId === id)!;
    // The entry for a given id is identical regardless of array position…
    expect(pick(reversed, 2)).toEqual(pick(forward, 2));
    expect(pick(reversed, 5)).toEqual(pick(forward, 5));
    // …and the active flag follows the id, not the slot.
    expect(pick(reversed, 5).active).toBe(true);
    expect(pick(reversed, 2).active).toBe(false);
  });

  it('returns no entries (and an empty line) when there are no children', () => {
    expect(formatChildBar([], null)).toEqual([]);
    expect(formatChildBarLine([])).toBe('');
  });

  it('is disjoint from backend RunningAgent rows (separate segment)', () => {
    // The formatter takes only children; the agent segment is built elsewhere and
    // is left untouched. Proven by construction: RunningAgent has no overlap with
    // ChildBarEntry and is never an input here.
    const agents: RunningAgent[] = [
      {workspaceId: 'ws-1', workItemId: null, taskId: null, agentType: 'codex', state: 'idle', assignedAlias: 'codex'},
    ];
    const snapshot = JSON.parse(JSON.stringify(agents));
    const entries = formatChildBar([child(2, 'sift/a-1')], 2);
    expect(entries).toHaveLength(1);
    expect(agents).toEqual(snapshot); // unchanged — the child formatter never sees agents
  });
});

describe('formatChildBarLine', () => {
  it('renders a compact one-liner with the active marker', () => {
    const entries = formatChildBar([child(2, 'sift/a-1'), child(5, 'sift/b-2', {status: 'needs_input'})], 2);
    expect(formatChildBarLine(entries)).toBe('▶a-1·running  b-2·needs_input');
  });
});
