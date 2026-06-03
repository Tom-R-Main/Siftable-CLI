/**
 * ControlClient — HTTP/SSE transport (daemon mode) + shared event types/helpers.
 *
 * In `sift interactive` A0 the LocalControlClient (in-process brain) is used
 * instead; this file is retained for the daemon transport path and because the
 * TUI imports the shared SseEvent/ControlState types and the eventTextDelta /
 * doneFallbackText helpers from here regardless of which transport is active.
 */
export interface RunningAgent {
  workspaceId: string;
  workItemId: string | null;
  taskId: string | null;
  agentType: string;
  state: string;
  assignedAlias: string | null;
}

export interface ControlState {
  available: boolean;
  model?: { provider: string; model: string; effort?: string | null } | null;
  authStatus?: string;
  context: { surface: string; runningAgents: RunningAgent[] } | null;
}

export interface SseEvent {
  type: string;
  content?: string;
  text?: string;
  toolCall?: { name: string; args?: Record<string, unknown>; detail?: string };
  toolResult?: { name: string; success?: boolean; output?: string; explorerActivity?: unknown };
  message?: { content?: string };
  result?: { content?: string } | unknown;
  error?: string;
  [key: string]: unknown;
}

export type ChatInputPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; dataUrl: string; detail?: "auto" | "low" | "high" };
export type ChatInput = string | ChatInputPart[];

/** Codex (ChatGPT-subscription) engine status, surfaced by `/codex`. */
export interface CodexStatus {
  /** Whether the `codex` CLI is installed/reachable. */
  installed: boolean;
  /** Signed-in account, or null when logged out / unavailable. */
  account: { type: string; email?: string; planType?: string } | null;
  /** Whether Codex is the active brain engine. */
  active: boolean;
  /** The model that would be used for Codex turns. */
  model: string;
}

/** Device-code login handle for the in-TUI Codex sign-in. */
export interface CodexLogin {
  verificationUri: string;
  userCode: string;
  /** Resolves when sign-in finishes (local mode only). */
  completion?: Promise<{ success: boolean; email?: string; error?: string }>;
}

/**
 * Common surface both transports implement so the TUI is transport-agnostic.
 * The `codex*` ops are optional because Codex is an in-process (local) engine;
 * the daemon transport does not implement them.
 */
export interface ControlTransport {
  state(): Promise<ControlState>;
  config(input: { provider?: string; model?: string; apiKey?: string; effort?: string }): Promise<{ provider: string; model: string; effort?: string }>;
  login(): Promise<{ verificationUri: string; userCode: string }>;
  send(input: ChatInput, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void>;
  codexStatus?(): Promise<CodexStatus>;
  codexLogin?(): Promise<CodexLogin>;
  codexLogout?(): Promise<void>;
  /** Switch the active brain engine to/from Codex; returns the new model state. */
  codexSetActive?(active: boolean): Promise<{ provider: string; model: string }>;
}

export class ControlClient implements ControlTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined
  ) {}

  async state(): Promise<ControlState> {
    const res = await fetch(`${this.baseUrl}/control/state`);
    if (!res.ok) throw new Error(`/control/state HTTP ${res.status}`);
    return (await res.json()) as ControlState;
  }

  async config(input: { provider?: string; model?: string; apiKey?: string; effort?: string }): Promise<{ provider: string; model: string; effort?: string }> {
    const res = await fetch(`${this.baseUrl}/control/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "x-executerm-dashboard-token": this.token } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`/control/config HTTP ${res.status}`);
    return (await res.json()) as { provider: string; model: string; effort?: string };
  }

  async login(): Promise<{ verificationUri: string; userCode: string }> {
    const res = await fetch(`${this.baseUrl}/control/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "x-executerm-dashboard-token": this.token } : {}),
      },
      body: "{}",
    });
    if (!res.ok) throw new Error(`/control/login HTTP ${res.status}`);
    return (await res.json()) as { verificationUri: string; userCode: string };
  }

  async send(
    text: ChatInput,
    onEvent: (event: SseEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/control/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { "x-executerm-dashboard-token": this.token } : {}),
      },
      body: JSON.stringify({ text: typeof text === "string" ? text : text.map((p) => (p.type === "text" ? p.text : "[image]")).join("") }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`/control/message HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "message";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          eventType = "message";
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          } catch {
            payload = {};
          }
          onEvent({ type: eventType, ...payload });
        }
      }
    }
  }
}

/** Extract a text delta from either event shape. */
export function eventTextDelta(e: SseEvent): string {
  if (e.type === "token" && typeof e.content === "string") return e.content;
  if (e.type === "text" && typeof e.text === "string") return e.text;
  return "";
}

/** On `done`, recover the full reply if no deltas streamed (the "(no response)" fix). */
export function doneFallbackText(e: SseEvent): string {
  if (typeof e.message?.content === "string") return e.message.content;
  const r = e.result as { content?: string } | undefined;
  if (r && typeof r.content === "string") return r.content;
  if (typeof e.text === "string") return e.text;
  return "";
}
