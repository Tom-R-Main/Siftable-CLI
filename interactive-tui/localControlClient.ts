/**
 * LocalControlClient — in-process transport for `sift interactive` (A0).
 *
 * Implements the same ControlTransport surface as the HTTP ControlClient, but
 * send() calls the Siftable agent harness directly (no daemon, no socket). This is
 * the single seam the TUI swaps on: index.tsx picks LocalControlClient when
 * SIFT_LOCAL_BRAIN is set.
 *
 *   state()   synthesized from token presence + the brain's current model
 *   config()  → setBrainModel (the /model and /key commands)
 *   login()   not a daemon round-trip in local mode — directs to `sift auth login`
 *   send()    → agentHarnessAsk, translating BrainEvent → SseEvent
 *
 * Brain functions are injected (defaulting to the real brain) so tests can
 * drive event translation and degraded states with a fake `ask`.
 */
import {
  agentHarnessAsk,
  setBrainModel,
  getBrainModel,
  compactActiveThread,
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
  CompactionReport,
  ControlState,
  ControlTransport,
  SseEvent,
} from "./controlClient";

export interface LocalBrainDeps {
  ask: typeof agentHarnessAsk;
  setModel: typeof setBrainModel;
  getModel: typeof getBrainModel;
  /** Resolve the Siftable token from env (launcher sets SIFT_PAT). */
  getToken: () => string | undefined;
  /** Metadata only: can the selected local adapter obtain its own credential? */
  hasProviderCredential: (provider: string) => boolean;
  /** Read the Codex account (memoized in the engine); null when logged out. */
  getCodexAccount: typeof getCodexAccount;
  /** Force a context compaction on the active session's agent. */
  compact: typeof compactActiveThread;
}

const defaultDeps: LocalBrainDeps = {
  ask: agentHarnessAsk,
  setModel: setBrainModel,
  getModel: getBrainModel,
  getToken: () => process.env.SIFT_PAT || process.env.EXF_PAT,
  hasProviderCredential: (provider) => {
    const names: Record<string, string> = {
      openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', meta: 'META_API_KEY',
      gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', claude: 'ANTHROPIC_API_KEY',
      xai: 'XAI_API_KEY', grok: 'XAI_API_KEY',
    };
    return !!(names[provider] && process.env[names[provider]]);
  },
  getCodexAccount,
  compact: compactActiveThread,
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
    const authed = this.deps.hasProviderCredential(model.provider);
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

  async compact(): Promise<CompactionReport> {
    return this.deps.compact();
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
    // Restore the default local agent-harness engine.
    return this.deps.setModel({ provider: "openrouter", model: "google/gemini-3.8-flash" });
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

    // Cancellation is a request, not proof that admitted effects stopped.
    // Continue observing receipts and keep the caller busy until settlement.
    const onAbort = () => onEvent({ type: "status", status: "stopping" });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.deps.ask(input, (event) => onEvent(event as SseEvent), signal);
      const run = result.run ?? result.result?.run;
      if (signal?.aborted || result.status === 'interrupted') {
        onEvent({type: 'interrupted', status: 'interrupted', run, providerReceipts: result.providerReceipts});
        const uncertainty = run?.toolEffects?.verificationRequired ?? run?.cancellation?.verificationRequired;
        if (uncertainty || run?.toolEffects?.certainty === 'unknown') {
          onEvent({type: 'error', error: 'Turn interrupted; tool effects may have occurred. Inspect the recorded results before retrying.', run});
        }
        throw Object.assign(abortError(result.error), {run, providerReceipts: result.providerReceipts});
      }
      if (result.error) {
        onEvent({ type: "error", error: result.error, run, providerReceipts: result.providerReceipts });
        throw Object.assign(new Error(result.error), {run, providerReceipts: result.providerReceipts});
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function abortError(message = 'aborted'): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}
