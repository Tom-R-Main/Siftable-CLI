/**
 * Lane C S5 — /spawn · /children · /enter · /leave command handlers.
 *
 * Handlers are pure over ctx.sessions (the TUI backs it with a real controller +
 * sessionContext; here we back it with spies). The load-bearing checks:
 *  - a write-capable /spawn with no scope and no escape is REJECTED with a remedy
 *    and never reaches the controller (no session created);
 *  - --rw-any creates an unserialized writer (explicit);
 *  - a Gate-A block surfaces as a message naming the conflicting child.
 */
import {interactiveCommands, type InteractiveCommandContext} from '../../interactive-tui/commands';
import {buildCommandContext} from '../helpers/interactive-command-context';

function run(ctx: InteractiveCommandContext, name: string, args: string[] = []): void {
  const cmd = interactiveCommands.find((c) => c.name === name || c.aliases?.includes(name));
  if (!cmd) throw new Error(`command not found: ${name}`);
  void cmd.run(ctx, args);
}

/** A sessions double with spies + controllable spawn/enter/leave results. */
function fakeSessions(overrides: Partial<Record<'spawn' | 'enter' | 'leave' | 'list' | 'activeChildId', unknown>> = {}) {
  return {
    list: jest.fn(() => []),
    activeChildId: jest.fn(() => null),
    spawn: jest.fn(() => ({ok: false, reason: 'unset'})),
    enter: jest.fn(() => ({ok: false, reason: 'unset'})),
    leave: jest.fn(() => ({ok: false, reason: 'not in a child session'})),
    ...overrides,
  };
}

function lastSystemText(messages: {role: string; text: string}[]): string {
  const sys = messages.filter((m) => m.role === 'system');
  return sys[sys.length - 1]?.text ?? '';
}

describe('/spawn — scope policy', () => {
  it('rejects a write-capable spawn with no --rw/--rw-any and creates NO session', () => {
    const sessions = fakeSessions();
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'spawn', ['fix', 'the', 'parser']);

    expect(sessions.spawn).not.toHaveBeenCalled();
    expect(lastSystemText(messages)).toMatch(/--rw <globs>/);
  });

  it('passes the title as usage when given no args (no throw, no session)', () => {
    const sessions = fakeSessions();
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'spawn', []);
    expect(sessions.spawn).not.toHaveBeenCalled();
    expect(lastSystemText(messages)).toMatch(/\/spawn <title>/);
  });

  it('--rw-any creates an unserialized read_write child and warns about it', () => {
    const sessions = fakeSessions({
      spawn: jest.fn(() => ({
        ok: true,
        session: {
          sessionId: 7,
          parentSessionId: 1,
          title: 'risky',
          repoRoot: '/repo',
          branch: 'sift/risky-abc123',
          baseBranch: 'main',
          worktreePath: '/wt/risky',
          sessionCwd: '/wt/risky',
          baseCommit: 'c0',
          headCommit: 'c0',
          accessMode: 'read_write',
          writeScope: [],
          conversationKey: 'k',
        },
      })),
    });
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'spawn', ['risky', '--rw-any']);

    expect(sessions.spawn).toHaveBeenCalledWith(
      expect.objectContaining({title: 'risky', accessMode: 'read_write', writeScope: undefined}),
    );
    const text = lastSystemText(messages);
    expect(text).toMatch(/spawned child #7/);
    expect(text).toMatch(/not serialized/i);
  });

  it('--rw <globs> passes a parsed scope (comma + space separated)', () => {
    const sessions = fakeSessions({spawn: jest.fn(() => ({ok: false, reason: 'irrelevant'}))});
    const {ctx} = buildCommandContext({sessions});
    run(ctx, 'spawn', ['edit', 'docs', '--rw', 'src/a.ts,src/b.ts', 'lib/**']);

    expect(sessions.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'edit docs',
        accessMode: 'read_write',
        writeScope: ['src/a.ts', 'src/b.ts', 'lib/**'],
      }),
    );
  });

  it('--ro makes a read-only child with no scope required', () => {
    const sessions = fakeSessions({spawn: jest.fn(() => ({ok: false, reason: 'x'}))});
    const {ctx} = buildCommandContext({sessions});
    run(ctx, 'spawn', ['look around', '--ro']);
    expect(sessions.spawn).toHaveBeenCalledWith(
      expect.objectContaining({title: 'look around', accessMode: 'read_only', writeScope: undefined}),
    );
  });

  it('surfaces a Gate-A block naming the conflicting child', () => {
    const sessions = fakeSessions({
      spawn: jest.fn(() => ({ok: false, reason: 'serialized behind running child #3 (shared scope: src/x.ts)', blockedBy: 3})),
    });
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'spawn', ['conflict', '--rw', 'src/x.ts']);
    const text = lastSystemText(messages);
    expect(text).toMatch(/blocked/i);
    expect(text).toMatch(/#3/);
  });
});

describe('/children · /enter · /leave', () => {
  it('/children lists children with an active marker', () => {
    const sessions = fakeSessions({
      activeChildId: jest.fn(() => 2),
      list: jest.fn(() => [
        {sessionId: 2, status: 'running', branch: 'sift/a-1', writeScope: ['src/a.ts'], accessMode: 'read_write'},
        {sessionId: 5, status: 'running', branch: 'sift/b-2', writeScope: [], accessMode: 'read_only'},
      ]),
    });
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'children');
    const text = lastSystemText(messages);
    expect(text).toMatch(/▶ #2/);
    expect(text).toMatch(/#5/);
    expect(text).toMatch(/\[ro\]/);
  });

  it('/children reports an empty list cleanly', () => {
    const {ctx, messages} = buildCommandContext({sessions: fakeSessions()});
    run(ctx, 'children');
    expect(lastSystemText(messages)).toMatch(/No child sessions/);
  });

  it('/enter resolves by stable session id', () => {
    const enter = jest.fn((id: number) => ({
      ok: true,
      session: {sessionId: id, branch: 'sift/a-1', worktreePath: '/wt/a'},
    }));
    const sessions = fakeSessions({enter});
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'enter', ['2']);
    expect(enter).toHaveBeenCalledWith(2);
    expect(lastSystemText(messages)).toMatch(/entered child #2/);
  });

  it('/enter without an id prints usage and does not call enter', () => {
    const sessions = fakeSessions();
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'enter', []);
    expect(sessions.enter).not.toHaveBeenCalled();
    expect(lastSystemText(messages)).toMatch(/\/enter <session-id>/);
  });

  it('/leave returns to the parent on success', () => {
    const sessions = fakeSessions({leave: jest.fn(() => ({ok: true}))});
    const {ctx, messages} = buildCommandContext({sessions});
    run(ctx, 'leave');
    expect(sessions.leave).toHaveBeenCalled();
    expect(lastSystemText(messages)).toMatch(/back in the parent/);
  });

  it('/leave at the parent reports it is not in a child', () => {
    const {ctx, messages} = buildCommandContext({sessions: fakeSessions()});
    run(ctx, 'leave');
    expect(lastSystemText(messages)).toMatch(/not in a child session/);
  });
});
