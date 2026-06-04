/**
 * Coverage gates — change-detectors that fail CI when a surface grows without a
 * corresponding test decision. Two gates:
 *
 *  1. Slash-command registry: every registered command is dispatchable, alias-
 *     resolvable, collision-free, advertised consistently, and survives a no-arg
 *     invocation. Adding a command to `interactiveCommands` that breaks any of
 *     these breaks the build.
 *  2. Codex app-server notifications: every method the copilot knows about has a
 *     declared disposition (surfaced as a BrainEvent, or intentionally ignored),
 *     and `mapCodexNotification` matches it. A new/unhandled method must be added
 *     here with an explicit decision.
 */
import {
  interactiveCommands,
  commandSuggestions,
  runInteractiveCommand,
} from '../../interactive-tui/commands';
import {mapCodexNotification} from '../../interactive-tui/codexEngine';
import {buildCommandContext} from '../helpers/interactive-command-context';

// ── Gate 1: slash-command registry ──────────────────────────────────────────
describe('coverage gate: slash-command registry', () => {
  const allNames = interactiveCommands.map((c) => c.name);
  const allTokens = interactiveCommands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

  it('has no duplicate names or aliases (no shadowed commands)', () => {
    const seen = new Map<string, number>();
    for (const token of allTokens) seen.set(token, (seen.get(token) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
    expect(dupes).toEqual([]);
  });

  it('resolves every name and alias through the dispatcher (no "unknown command")', async () => {
    for (const token of allTokens) {
      const {ctx, messages} = buildCommandContext();
      await runInteractiveCommand(ctx, `/${token}`);
      const unknown = messages.find((m) => m.text.startsWith('unknown command:'));
      expect(unknown).toBeUndefined();
    }
  });

  it('advertises exactly the non-hidden commands in suggestions and /help', async () => {
    const expectedVisible = allNames.filter((name) => {
      const cmd = interactiveCommands.find((c) => c.name === name)!;
      return !cmd.hidden;
    });
    expect(commandSuggestions().map((c) => c.name).sort()).toEqual([...expectedVisible].sort());

    const {ctx, messages} = buildCommandContext();
    await runInteractiveCommand(ctx, '/help');
    const help = messages.map((m) => m.text).join('\n');
    for (const name of expectedVisible) expect(help).toContain(`/${name}`);
    for (const cmd of interactiveCommands) {
      if (cmd.hidden) expect(help).not.toContain(`/${cmd.name} `);
    }
  });

  it('every command survives a no-arg invocation without throwing', async () => {
    for (const cmd of interactiveCommands) {
      const {ctx} = buildCommandContext();
      await expect(runInteractiveCommand(ctx, `/${cmd.name}`)).resolves.toBeUndefined();
    }
  });

  it('every command declares a non-empty description', () => {
    const undocumented = interactiveCommands.filter((c) => !c.description?.trim()).map((c) => c.name);
    expect(undocumented).toEqual([]);
  });
});

// ── Gate 2: codex app-server notification dispositions ──────────────────────
/**
 * Every app-server notification method the copilot may receive, and whether
 * `mapCodexNotification` is expected to surface it. `surfaced` methods must
 * (under the right params) produce a BrainEvent; `ignored` methods must always
 * map to null. Seeing a method not listed here is the signal to add it with a
 * deliberate decision — that is the gate.
 */
const KNOWN_CODEX_NOTIFICATIONS: Record<string, 'surfaced' | 'ignored'> = {
  // Surfaced into the transcript / tool rail.
  'item/agentMessage/delta': 'surfaced',
  'item/started': 'surfaced',
  'item/completed': 'surfaced',
  error: 'surfaced',
  // Lifecycle / bookkeeping chatter the copilot deliberately does not render.
  'turn/started': 'ignored',
  'turn/completed': 'ignored',
  'thread/started': 'ignored',
  'thread/tokenUsage/updated': 'ignored',
  'item/reasoning/delta': 'ignored',
  'item/updated': 'ignored',
};

/** A params payload that should make a `surfaced` method actually emit. */
const SURFACING_PARAMS: Record<string, Record<string, unknown>> = {
  'item/agentMessage/delta': {delta: 'hi'},
  'item/started': {item: {type: 'commandExecution', id: '1', command: 'ls'}},
  'item/completed': {item: {type: 'commandExecution', id: '1', exitCode: 0}},
  error: {error: {message: 'boom'}, willRetry: false},
};

describe('coverage gate: codex notification dispositions', () => {
  it.each(Object.entries(KNOWN_CODEX_NOTIFICATIONS))(
    '%s behaves as declared (%s)',
    (method, disposition) => {
      if (disposition === 'ignored') {
        expect(mapCodexNotification(method, {})).toBeNull();
      } else {
        const event = mapCodexNotification(method, SURFACING_PARAMS[method] ?? {});
        expect(event).not.toBeNull();
      }
    },
  );

  it('every surfaced method has a documented surfacing-params fixture', () => {
    const surfaced = Object.entries(KNOWN_CODEX_NOTIFICATIONS)
      .filter(([, d]) => d === 'surfaced')
      .map(([m]) => m);
    for (const method of surfaced) expect(SURFACING_PARAMS).toHaveProperty(method);
  });

  it('ignores an unknown/unlisted method (default disposition is silence)', () => {
    expect(mapCodexNotification('totally/new/method', {whatever: true})).toBeNull();
  });
});
