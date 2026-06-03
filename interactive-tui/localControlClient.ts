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
import {
  getCodexAccount,
  getCodexInstallState,
  startCodexLogin,
  codexLogout,
  CODEX_PROVIDER,
  CODEX_DEFAULT_MODEL,
} from "./codexEngine";
import type {
  ChatInput,
  CodexLogin,
  CodexStatus,
  ControlState,
  ControlTransport,
  SseEvent,
} from "./controlClient";

export interface LocalBrainDeps {
  ask: typeof openfunctionAsk;
  setModel: typeof setBrainModel;
  getModel: typeof getBrainModel;
  /** Resolve the Siftable token from env (launcher sets SIFT_PAT). */
  getToken: () => string | undefined;
  /** Read the Codex account (memoized in the engine); null when logged out. */
  getCodexAccount: typeof getCodexAccount;
}

const defaultDeps: LocalBrainDeps = {
  ask: openfunctionAsk,
  setModel: setBrainModel,
  getModel: getBrainModel,
  getToken: () => process.env.SIFT_PAT || process.env.EXF_PAT,
  getCodexAccount,
};

export class LocalControlClient implements ControlTransport {
  private readonly deps: LocalBrainDeps;

  constructor(deps?: Partial<LocalBrainDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async state(): Promise<ControlState> {
    const model = this.deps.getModel();
    // When Codex is the active engine, auth is gated by the Codex account, not
    // the Siftable token (which still backs the read tools either way).
    if (model.provider === CODEX_PROVIDER) {
      const account = await this.deps.getCodexAccount().catch(() => null);
      const authed = Boolean(account);
      return {
        available: authed,
        model,
        authStatus: authed ? "authenticated" : "unauthenticated",
        context: { surface: "local", runningAgents: [] },
      };
    }
    const authed = Boolean(this.deps.getToken());
    return {
      available: authed,
      model,
      authStatus: authed ? "authenticated" : "unauthenticated",
      context: { surface: "local", runningAgents: [] },
    };
  }

  async config(input: { provider?: string; model?: string; apiKey?: string; effort?: string }): Promise<{ provider: string; model: string; effort?: string }> {
    return this.deps.setModel(input);
  }

  async codexStatus(): Promise<CodexStatus> {
    const account = await this.deps.getCodexAccount().catch(() => null);
    const model = this.deps.getModel();
    return {
      installed: getCodexInstallState() !== "missing",
      account,
      active: model.provider === CODEX_PROVIDER,
      model: model.provider === CODEX_PROVIDER ? model.model : CODEX_DEFAULT_MODEL,
    };
  }

  async codexLogin(): Promise<CodexLogin> {
    const { verificationUri, userCode, completion } = await startCodexLogin();
    return { verificationUri, userCode, completion };
  }

  async codexLogout(): Promise<void> {
    await codexLogout();
  }

  async codexSetActive(active: boolean): Promise<{ provider: string; model: string }> {
    if (active) {
      return this.deps.setModel({ provider: CODEX_PROVIDER, model: CODEX_DEFAULT_MODEL });
    }
    // Restore the OpenFunction default engine.
    return this.deps.setModel({ provider: "openrouter", model: "google/gemini-3.5-flash" });
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

    const askPromise = this.deps.ask(input, forward, signal).then((result) => {
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
