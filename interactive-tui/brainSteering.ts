/**
 * Durable input delivery for the local brain: the between-turn session
 * mailbox drain, and steering that joins a running turn.
 *
 * Steering is published to the conversation's durable mailbox before it is
 * acknowledged to the user, and a turn reads only the ids it accepted: other
 * mailbox instructions keep their between-turn delivery.
 */
import type { SteeringSource } from './agent-harness/framework/chat-agent-types';
import {
  acknowledgeSessionInstruction,
  enqueueSessionInstruction,
  listPendingSessionInstructions,
  SessionMailboxPublicationIndeterminateError,
} from './sessionMailbox';

interface ActiveSteering {
  key: string;
  /** Accepted id → text. */
  accepted: Map<string, string>;
  /** Delivered id → its index in the agent's history when appended. */
  delivered: Map<string, number>;
}

/** The local-harness turn now running, if any. */
let activeSteering: ActiveSteering | undefined;
const mailboxDrains = new Map<string, Promise<void>>();

export type SteerResult =
  | { accepted: true; id: string; durability: 'confirmed' | 'unconfirmed' }
  | { accepted: false; reason: string };

/** Publish a correction for the running turn; refused when none is running. */
export function steerTurn(message: string): SteerResult {
  const turn = activeSteering;
  if (!turn) return {accepted: false, reason: 'no turn is running'};
  try {
    const record = enqueueSessionInstruction(turn.key, message);
    turn.accepted.set(record.instructionId, message);
    return {accepted: true, id: record.instructionId, durability: 'confirmed'};
  } catch (error) {
    // Published, but the directory entry may not survive a crash. The turn
    // can still consume it, so it must not be reported as refused.
    if (error instanceof SessionMailboxPublicationIndeterminateError) {
      turn.accepted.set(error.receipt.instructionId, message);
      return {accepted: true, id: error.receipt.instructionId, durability: 'unconfirmed'};
    }
    return {accepted: false, reason: error instanceof Error ? error.message : String(error)};
  }
}

export interface TurnSteering {
  /** Passed to ChatAgent.chat as `steering`. */
  source: SteeringSource;
  /**
   * End the steering window; idempotent. Returns how many accepted
   * corrections remain pending for the next turn.
   */
  settle(finished: boolean): number;
}

/**
 * Open the steering window for one turn in conversation `key`. When
 * `enabled` is false (navigation moved the session during setup), the turn
 * runs without steering rather than publish to a conversation it isn't in.
 */
export function beginTurnSteering(
  key: string,
  enabled: boolean,
  agent: {getHistory?: () => unknown[]},
  onDelivered: (id: string) => void,
): TurnSteering {
  const steering: ActiveSteering = {key, accepted: new Map(), delivered: new Map()};
  if (enabled) activeSteering = steering;
  let carried: number | undefined;
  return {
    source: {
      pending: () => {
        if (steering.accepted.size === 0) return [];
        try {
          return listPendingSessionInstructions(key)
            .filter(instruction => steering.accepted.has(instruction.instructionId))
            .map(instruction => ({id: instruction.instructionId, message: instruction.instruction}));
        } catch {
          // An unreadable mailbox leaves steering pending for the next turn.
          return [];
        }
      },
      onDelivered: id => {
        // ChatAgent calls this right after appending, so the message is last.
        steering.delivered.set(id, (agent.getHistory?.().length ?? 0) - 1);
        onDelivered(id);
      },
    },
    settle: finished => (carried ??= settleSteering(steering, finished, agent)),
  };
}

/**
 * End a turn's steering window and acknowledge every correction the
 * conversation now holds. A finished turn holds all it delivered. A failed
 * turn may have rolled its history back to an earlier prefix, so a delivered
 * correction counts only if its own position in history still holds it; one
 * that was rolled back stays in the mailbox for the next turn. Acknowledging
 * what survived keeps the next turn's drain from appending it a second time.
 * If history was compacted mid-turn the position check misses, and the
 * correction is delivered again rather than lost.
 */
function settleSteering(
  steering: ActiveSteering,
  finished: boolean,
  agent: {getHistory?: () => unknown[]},
): number {
  if (activeSteering === steering) activeSteering = undefined;
  let history: unknown[] = [];
  if (!finished && steering.delivered.size > 0) {
    try {
      history = agent.getHistory?.() ?? [];
    } catch {
      history = [];
    }
  }
  const stillHeld = (index: number, text: string) => {
    const m = history[index] as {role?: unknown; content?: unknown} | undefined;
    return m?.role === 'user' && m.content === text;
  };
  let carried = 0;
  for (const [id, text] of steering.accepted) {
    const index = steering.delivered.get(id);
    if (index !== undefined && (finished || stillHeld(index, text))) {
      try {
        acknowledgeSessionInstruction(steering.key, id);
        continue;
      } catch {
        // Left pending: the next turn delivers it again (at least once).
      }
    }
    carried += 1;
  }
  return carried;
}

/** Deliver a conversation's pending mailbox instructions before its next turn. */
export async function drainSessionMailbox(
  key: string,
  agent: {ingestExternalMessage?: (message: string, options: {id: string}) => Promise<unknown>},
): Promise<void> {
  const prior = mailboxDrains.get(key) ?? Promise.resolve();
  const drain = prior.then(async () => {
    // During a turn the agent's turn lock is held, so ingesting here would
    // wait for the turn while an in-turn reader (read_tool_output, inspect)
    // waits for this drain. The next turn's pre-turn drain delivers instead.
    if (activeSteering?.key === key) return;
    const pending = listPendingSessionInstructions(key);
    if (pending.length === 0) return;
    if (typeof agent.ingestExternalMessage !== 'function') {
      throw new Error(
        'This agent harness cannot consume durable session instructions; update the bundled harness.',
      );
    }
    for (const instruction of pending) {
      // ingestExternalMessage records instructionId in the append-only journal
      // before acknowledgement. A crash between these operations redelivers,
      // the journal deduplicates it, and the next drain safely removes the file.
      await agent.ingestExternalMessage(instruction.instruction, {id: instruction.instructionId});
      acknowledgeSessionInstruction(key, instruction.instructionId);
    }
  });
  mailboxDrains.set(key, drain);
  try {
    await drain;
  } finally {
    if (mailboxDrains.get(key) === drain) mailboxDrains.delete(key);
  }
}

/** Drains still running, for bounded shutdown. */
export function pendingMailboxDrains(): Promise<void>[] {
  return [...mailboxDrains.values()];
}

/** Test seam: forget drains and any open steering window. */
export function resetBrainSteeringForTests(): void {
  mailboxDrains.clear();
  activeSteering = undefined;
}
