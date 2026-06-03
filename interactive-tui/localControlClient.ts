/**
 * LocalControlClient — in-process transport for `sift interactive` (A0).
 *
 * Implements the same ControlTransport surface as the HTTP ControlClient, but
 * send() calls the OpenFunction brain directly (no daemon, no socket). This is
 * the single seam the TUI swaps on: index.tsx picks LocalControlClient when
 * SIFT_LOCAL_BRAIN is set.
 *
 *   state()   synthesized from token presence + the brain's current model
 *   config()  → setBrainModel (the /model and /key commands)
 *   login()   not a daemon round-trip in local mode — directs to `sift auth login`
 *   send()    → openfunctionAsk, translating BrainEvent → SseEvent
 *
 * Brain functions are injected (defaulting to the real brain) so tests can
 * drive event translation and degraded states with a fake `ask`.
 */
import {
  openfunctionAsk,
  setBrainModel,
  getBrainModel,
  type BrainEvent,
} from "./brain";
import type { ChatInput, ControlState, ControlTransport, SseEvent } from "./controlClient";

export interface LocalBrainDeps {
  ask: typeof openfunctionAsk;
  setModel: typeof setBrainModel;
  getModel: typeof getBrainModel;
  /** Resolve the Siftable token from env (launcher sets SIFT_PAT). */
  getToken: () => string | undefined;
}

const defaultDeps: LocalBrainDeps = {
  ask: openfunctionAsk,
  setModel: setBrainModel,
  getModel: getBrainModel,
  getToken: () => process.env.SIFT_PAT || process.env.EXF_PAT,
};

export class LocalControlClient implements ControlTransport {
  private readonly deps: LocalBrainDeps;

  constructor(deps?: Partial<LocalBrainDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async state(): Promise<ControlState> {
    const authed = Boolean(this.deps.getToken());
    return {
      available: authed,
      model: this.deps.getModel(),
      authStatus: authed ? "authenticated" : "unauthenticated",
      context: { surface: "local", runningAgents: [] },
    };
  }

  async config(input: { provider?: string; model?: string; apiKey?: string }): Promise<{ provider: string; model: string }> {
    return this.deps.setModel(input);
  }

  async login(): Promise<{ verificationUri: string; userCode: string }> {
    // Local mode has no daemon device-flow endpoint. The launcher already
    // requires a token to start, so this is the rare "token expired mid-session"
    // path: surface a clear instruction rather than a broken round-trip.
    throw new Error(
      "In local mode, run `sift auth login` in your shell, then restart `sift interactive`.",
    );
  }

  async send(
    input: ChatInput,
    onEvent: (event: SseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();

    // The in-process brain runs an async generator we can't interrupt mid-flight.
    // Best-effort abort for A0: stop forwarding events and reject so the TUI
    // shows "paused"; the brain finishes in the background and its tail is dropped.
    let stopped = false;
    const forward = (e: BrainEvent) => {
      if (!stopped) onEvent(e as SseEvent);
    };

    const askPromise = this.deps.ask(input, forward).then((result) => {
      if (stopped) return;
      // openfunctionAsk never throws; a brain failure arrives as {error}.
      // Surface it as an SSE error event the TUI already renders.
      if (result.error) {
        onEvent({ type: "error", error: result.error });
      }
    });

    if (!signal) {
      await askPromise;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        stopped = true;
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      askPromise
        .then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        })
        .catch((err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  }
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
