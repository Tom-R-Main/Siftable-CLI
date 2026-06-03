/**
 * Codex engine for `sift interactive` — drives the OpenAI `codex app-server`
 * sidecar over JSON-RPC (newline-delimited, stdio) so users can power the
 * copilot with their ChatGPT subscription instead of a model API key.
 *
 * We deliberately do NOT own the OAuth token lifecycle. Codex owns sign-in,
 * token persistence, and refresh; we speak the documented `account/*` and
 * `thread`/`turn` methods. In-TUI login uses the device-code flow
 * (`account/login/start { type: "chatgptDeviceCode" }`), which is the cleanest
 * terminal UX (no localhost browser callback to babysit).
 *
 * Wiring:
 *   - brain.ts dynamically imports `codexAsk` and routes to it when the active
 *     provider is `codex` (the dispatcher in openfunctionAsk).
 *   - localControlClient.ts imports the control ops (account/login/logout) to
 *     back the optional ControlTransport codex* methods and the `/codex` command.
 *
 * WORKSPACE-WRITE + GATED: turns run in a `workspace-write` sandbox confined to
 * the repo root (writableRoots), with approvalPolicy `on-request`. Codex reads,
 * writes, and runs commands freely inside the repo; when it needs to escalate
 * (network, writes outside the repo) it asks, and we route that request through
 * the 4-way approval gate (`confirmGate`) into the TUI overlay. A "bypass"
 * decision flips the session to approvalPolicy `never`. Absent a UI listener,
 * every approval DENIES — codex never acts unattended.
 */
import { spawn, execSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { BrainEvent, BrainAskResult, ChatInput } from './brain';
import { requestApproval, isBypassing, type ApprovalDecision } from './confirmGate';

/** app-server is spawned with piped stdin/stdout and a discarded (null) stderr. */
type CodexProc = ChildProcessByStdio<Writable, Readable, null>;

/** Default Codex model surfaced when the user switches the engine on. */
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';
export const CODEX_PROVIDER = 'codex';

export interface CodexAccount {
  type: string;
  email?: string;
  planType?: string;
}

export interface CodexLoginHandle {
  verificationUri: string;
  userCode: string;
  /** Resolves when Codex reports the device-code login finished (or failed). */
  completion: Promise<{ success: boolean; email?: string; error?: string }>;
}

export type CodexInstallState = 'unknown' | 'ok' | 'missing';

type JsonValue = unknown;
type NotificationListener = (method: string, params: Record<string, JsonValue>) => void;

/** A pending JSON-RPC request awaiting its response. */
interface Pending {
  resolve: (result: Record<string, JsonValue>) => void;
  reject: (err: Error) => void;
}

function codexBin(): string {
  return process.env.CODEX_BIN || 'codex';
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
    else if (process.platform === 'win32') execSync(`start "" ${JSON.stringify(url)}`, { stdio: 'ignore' });
    else execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
  } catch {
    /* user can open the URL manually */
  }
}

/** A server→client approval request, normalized for the approval gate/overlay. */
export interface CodexApprovalRequest {
  method: string;
  kind: 'command' | 'edit' | 'permission';
  /** The command string or target path being approved. */
  target: string;
  /** Secondary line: cwd, change summary, or the escalation reason. */
  detail: string;
}

/** Approval methods we surface for a decision; anything else is unsupported. */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

/**
 * Map our 4-way decision to the JSON-RPC response for a given approval method.
 * Pure (no I/O) so the mapping is unit-testable. v2 command/fileChange use
 * accept/acceptForSession/decline; v1 exec/applyPatch use the ReviewDecision
 * casing (approved/approved_for_session/denied). "bypass" responds like "allow"
 * here — the session-wide stop-asking is handled by approvalPolicy elsewhere.
 */
export function codexApprovalResponse(
  method: string,
  decision: ApprovalDecision,
): Record<string, JsonValue> {
  const isV1 = method === 'execCommandApproval' || method === 'applyPatchApproval';
  if (decision === 'deny') return { decision: isV1 ? 'denied' : 'decline' };
  if (decision === 'always') return { decision: isV1 ? 'approved_for_session' : 'acceptForSession' };
  return { decision: isV1 ? 'approved' : 'accept' }; // allow | bypass
}

/** Normalize an approval request's params into the gate's display shape. Pure. */
export function buildApprovalRequest(
  method: string,
  params: Record<string, JsonValue>,
): CodexApprovalRequest {
  const str = (v: JsonValue): string => (typeof v === 'string' ? v : '');
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const first = changes[0] as Record<string, JsonValue> | undefined;
    const path = first && typeof first.path === 'string' ? first.path : str(params.path);
    return {
      method,
      kind: 'edit',
      target: path || 'file change',
      detail: str(params.reason) || (changes.length > 1 ? `${changes.length} files` : ''),
    };
  }
  return {
    method,
    kind: 'command',
    target: str(params.command) || 'command',
    detail: str(params.reason) || str(params.cwd),
  };
}

type Approver = (req: CodexApprovalRequest) => Promise<ApprovalDecision>;

/**
 * One persistent `codex app-server` process and the JSON-RPC plumbing over its
 * stdio. Notifications fan out to listeners; server→client approval requests are
 * routed through `approver` (default: deny — codex never acts unattended).
 */
class CodexClient {
  private proc: CodexProc | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<NotificationListener>();
  private ready: Promise<void> | null = null;
  private approver: Approver = async () => 'deny';

  /** Install the approval handler (wired to the confirm gate by getClient). */
  setApprover(fn: Approver): void {
    this.approver = fn;
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.connect();
    return this.ready;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let proc: CodexProc;
      try {
        proc = spawn(codexBin(), ['app-server'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          cwd: process.env.SIFT_USER_CWD || process.cwd(),
          env: process.env,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.proc = proc;
      proc.on('error', (err) => {
        // ENOENT etc. — surface to all current waiters and reset.
        this.failAll(err instanceof Error ? err : new Error(String(err)));
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      proc.on('exit', () => {
        this.failAll(new Error('codex app-server exited'));
        this.proc = null;
        this.ready = null;
      });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => this.onData(chunk));

      // Handshake: initialize → initialized.
      this.request('initialize', {
        clientInfo: { name: 'sift_tui', title: 'Sift TUI', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
        .then(() => {
          this.notify('initialized', {});
          resolve();
        })
        .catch(reject);
    });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, JsonValue>;
      try {
        msg = JSON.parse(line) as Record<string, JsonValue>;
      } catch {
        continue; // ignore non-JSON lines (defensive; stderr is already dropped)
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, JsonValue>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : undefined;

    if (hasId && method) {
      // Server→client request (approvals, tool calls). Route through the gate.
      void this.handleServerRequest(
        msg.id as number | string,
        method,
        (msg.params as Record<string, JsonValue>) ?? {},
      );
      return;
    }
    if (hasId) {
      // Response to one of our requests.
      const id = msg.id as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error) {
        const e = msg.error as { message?: string };
        pending.reject(new Error(e.message || 'codex rpc error'));
      } else {
        pending.resolve((msg.result as Record<string, JsonValue>) ?? {});
      }
      return;
    }
    if (method) {
      const params = (msg.params as Record<string, JsonValue>) ?? {};
      for (const fn of this.listeners) fn(method, params);
    }
  }

  /**
   * Handle a server-initiated request. Approval requests are routed through the
   * approver (the 4-way confirm gate); a thrown/errored approver denies. Always
   * responds so a turn can never deadlock. Permission-profile escalations and
   * unknown methods are declined as "unsupported" (safe = not granted).
   */
  private async handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, JsonValue>,
  ): Promise<void> {
    if (!APPROVAL_METHODS.has(method)) {
      this.send({ id, error: { code: -32601, message: 'unsupported by sift_tui' } });
      return;
    }
    let decision: ApprovalDecision = 'deny';
    try {
      decision = await this.approver(buildApprovalRequest(method, params));
    } catch {
      decision = 'deny';
    }
    this.send({ id, result: codexApprovalResponse(method, decision) });
  }

  private send(obj: Record<string, JsonValue>): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const id = this.nextId++;
    return new Promise<Record<string, JsonValue>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, JsonValue>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(fn: NotificationListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  shutdown(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    this.ready = null;
    this.failAll(new Error('codex client shut down'));
  }
}

// ── Singleton + lifecycle ────────────────────────────────────────────────────
let client: CodexClient | null = null;
let installState: CodexInstallState = 'unknown';
let threadId: string | null = null;
let accountCache: { account: CodexAccount | null; ts: number } | null = null;
const ACCOUNT_TTL_MS = 15_000;

/** Resolve (or lazily spawn) the Codex client; null if the CLI is unavailable. */
/** Repo/workspace root codex may write to, and run commands from. */
function workspaceRoot(): string {
  return process.env.SIFT_WORKSPACE_ROOT || process.env.SIFT_USER_CWD || process.cwd();
}

/** Approval posture for the next turn — "never" once the user has chosen bypass. */
function approvalPolicyNow(): 'never' | 'on-request' {
  return isBypassing() ? 'never' : 'on-request';
}

async function getClient(): Promise<CodexClient | null> {
  if (!client) {
    client = new CodexClient();
    // Route codex's approval requests through the shared 4-way confirm gate.
    client.setApprover((req) =>
      requestApproval({
        kind: req.kind === 'edit' ? 'edit' : 'command',
        path: req.target,
        detail: req.detail,
        allowAlways: true,
      }),
    );
  }
  try {
    await client.ensureReady();
    installState = 'ok';
    return client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|spawn/i.test(message)) installState = 'missing';
    client = null;
    return null;
  }
}

export function getCodexInstallState(): CodexInstallState {
  return installState;
}

export function shutdownCodex(): void {
  client?.shutdown();
  client = null;
  threadId = null;
  accountCache = null;
}

// Best-effort cleanup so we never orphan an app-server process.
process.once('exit', () => client?.shutdown());
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    client?.shutdown();
  });
}

function toAccount(raw: Record<string, JsonValue> | null | undefined): CodexAccount | null {
  if (!raw || typeof raw.type !== 'string') return null;
  return {
    type: raw.type,
    email: typeof raw.email === 'string' ? raw.email : undefined,
    planType: typeof raw.planType === 'string' ? raw.planType : undefined,
  };
}

/** Read the Codex account (memoized). Returns null if logged out or unavailable. */
export async function getCodexAccount(force = false): Promise<CodexAccount | null> {
  if (!force && accountCache && Date.now() - accountCache.ts < ACCOUNT_TTL_MS) {
    return accountCache.account;
  }
  const c = await getClient();
  if (!c) {
    accountCache = { account: null, ts: Date.now() };
    return null;
  }
  try {
    const res = await c.request('account/read', { refreshToken: false });
    const account = toAccount(res.account as Record<string, JsonValue> | null);
    accountCache = { account, ts: Date.now() };
    return account;
  } catch {
    accountCache = { account: null, ts: Date.now() };
    return null;
  }
}

/** Start the device-code login flow. Throws if the Codex CLI is unavailable. */
export async function startCodexLogin(): Promise<CodexLoginHandle> {
  const c = await getClient();
  if (!c) {
    throw new Error(
      'Codex CLI not found. Install it (https://developers.openai.com/codex), then retry.',
    );
  }
  const res = await c.request('account/login/start', { type: 'chatgptDeviceCode' });
  const loginId = typeof res.loginId === 'string' ? res.loginId : null;
  const verificationUri = String(res.verificationUrl || '');
  const userCode = String(res.userCode || '');

  const completion = new Promise<{ success: boolean; email?: string; error?: string }>((resolve) => {
    const off = c.onNotification(async (method, params) => {
      if (method !== 'account/login/completed') return;
      if (loginId && params.loginId && params.loginId !== loginId) return;
      off();
      const success = params.success === true;
      if (success) {
        const account = await getCodexAccount(true);
        resolve({ success: true, email: account?.email });
      } else {
        resolve({ success: false, error: typeof params.error === 'string' ? params.error : undefined });
      }
    });
  });

  if (verificationUri) openBrowser(verificationUri);
  return { verificationUri, userCode, completion };
}

/** Log out of Codex (best effort). */
export async function codexLogout(): Promise<void> {
  const c = await getClient();
  if (!c) return;
  try {
    await c.request('account/logout', {});
  } finally {
    accountCache = { account: null, ts: Date.now() };
  }
}

// ── Turn driving ─────────────────────────────────────────────────────────────

/** Map a Codex thread item to a one-line tool name for the TUI step display. */
function toolNameFor(item: Record<string, JsonValue>): string | null {
  switch (item.type) {
    case 'commandExecution':
      return 'shell';
    case 'fileChange':
      return 'edit';
    case 'webSearch':
      return 'web_search';
    case 'mcpToolCall':
      return `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`;
    case 'dynamicToolCall':
      return String(item.tool ?? 'tool');
    case 'imageGeneration':
      return 'image';
    default:
      return null; // agentMessage / reasoning / userMessage / plan etc.
  }
}

function clipStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * A short one-liner describing what a tool item is doing — the command, search
 * query, or changed path. The app-server hands us `command` already shlex-joined
 * (see item_builders.rs), so no array handling is needed here.
 */
function itemDetail(item: Record<string, JsonValue>): string | undefined {
  switch (item.type) {
    case 'commandExecution':
      return typeof item.command === 'string' && item.command.trim()
        ? clipStr(item.command.trim(), 200)
        : undefined;
    case 'webSearch':
      return typeof item.query === 'string' && item.query.trim()
        ? clipStr(item.query.trim(), 160)
        : undefined;
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = changes[0] as Record<string, JsonValue> | undefined;
      const path = first && typeof first.path === 'string' ? first.path : undefined;
      if (!path) return undefined;
      return changes.length > 1 ? `${path} (+${changes.length - 1} more)` : path;
    }
    case 'mcpToolCall':
      return `${String(item.server ?? 'mcp')}/${String(item.tool ?? 'tool')}`;
    default:
      return undefined;
  }
}

/**
 * The captured output of a completed tool item (the TUI clips it for display).
 * Only commandExecution carries stdout/stderr (`aggregatedOutput`).
 */
function itemOutput(item: Record<string, JsonValue>): string | undefined {
  if (item.type === 'commandExecution') {
    const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    return out.trim() ? out : undefined;
  }
  return undefined;
}

function itemSucceeded(item: Record<string, JsonValue>): boolean {
  const status = typeof item.status === 'string' ? item.status : '';
  if (status && /fail|error|denied|declined|cancel|abort/i.test(status)) return false;
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return false;
  if (item.success === false) return false;
  return true;
}

/**
 * Translate a Codex app-server notification into the BrainEvent the TUI already
 * understands. Pure and side-effect free so it can be unit tested. Returns null
 * for notifications the copilot doesn't surface (reasoning, lifecycle chatter).
 */
export function mapCodexNotification(
  method: string,
  params: Record<string, JsonValue>,
): BrainEvent | null {
  switch (method) {
    case 'item/agentMessage/delta':
      return typeof params.delta === 'string' ? { type: 'token', content: params.delta } : null;
    case 'item/started': {
      const item = params.item as Record<string, JsonValue> | undefined;
      if (!item) return null;
      const name = toolNameFor(item);
      if (!name) return null;
      const detail = itemDetail(item);
      return { type: 'tool_call', toolCall: detail ? { name, detail } : { name } };
    }
    case 'item/completed': {
      const item = params.item as Record<string, JsonValue> | undefined;
      if (!item) return null;
      const name = toolNameFor(item);
      if (!name) return null;
      const success = itemSucceeded(item);
      const output = itemOutput(item);
      return {
        type: 'tool_result',
        toolResult: output ? { name, success, output } : { name, success },
      };
    }
    case 'error': {
      const err = params.error as { message?: string } | undefined;
      if (params.willRetry === true) return null;
      return { type: 'error', error: err?.message || 'codex error' };
    }
    default:
      return null;
  }
}

function toUserInput(input: ChatInput): Array<Record<string, JsonValue>> {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, text_elements: [] }];
  }
  const out: Array<Record<string, JsonValue>> = [];
  for (const part of input) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text, text_elements: [] });
    } else if (part.type === 'image') {
      out.push({ type: 'image', url: part.dataUrl, detail: part.detail ?? 'auto' });
    }
  }
  if (!out.length) out.push({ type: 'text', text: '', text_elements: [] });
  return out;
}

async function ensureThread(c: CodexClient, model?: string): Promise<string> {
  if (threadId) return threadId;
  const res = await c.request('thread/start', {
    cwd: process.env.SIFT_USER_CWD || process.cwd(),
    approvalPolicy: approvalPolicyNow(),
    sandbox: 'workspace-write',
    ...(model ? { model } : {}),
  });
  const thread = res.thread as Record<string, JsonValue> | undefined;
  threadId = thread && typeof thread.id === 'string' ? thread.id : null;
  if (!threadId) throw new Error('codex thread/start returned no thread id');
  return threadId;
}

/**
 * Run one turn against Codex. Mirrors openfunctionAsk: streams BrainEvents to
 * onEvent and resolves with the assembled reply (never throws — a failure comes
 * back as {error} so the TUI renders a degraded state). The thread is reused
 * across calls so the conversation keeps context within the session.
 */
/** Reasoning efforts Codex (gpt-5.x) accepts on a turn. `none`/`minimal` map to omitting it. */
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export async function codexAsk(
  input: ChatInput,
  onEvent: (event: BrainEvent) => void,
  opts: { signal?: AbortSignal; model?: string; effort?: string } = {},
): Promise<BrainAskResult> {
  const c = await getClient();
  if (!c) {
    return {
      text: '',
      error: 'Codex CLI not found. Install it (https://developers.openai.com/codex), then retry.',
    };
  }

  const account = await getCodexAccount();
  if (!account) {
    return { text: '', error: 'Not signed in to Codex. Run /codex login.' };
  }

  let tid: string;
  try {
    tid = await ensureThread(c, opts.model);
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) };
  }

  let assembled = '';
  let turnId: string | undefined;

  return new Promise<BrainAskResult>((resolve) => {
    let settled = false;
    const finish = (result: BrainAskResult) => {
      if (settled) return;
      settled = true;
      off();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const off = c.onNotification((method, params) => {
      // Scope to this thread/turn (single turn at a time, but stay strict).
      if (params.threadId && params.threadId !== tid) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;

      if (method === 'turn/completed') {
        const turn = params.turn as Record<string, JsonValue> | undefined;
        const status = turn && typeof turn.status === 'string' ? turn.status : 'completed';
        onEvent({ type: 'done', message: { content: assembled } });
        if (status === 'failed') {
          const err = (turn?.error as { message?: string } | undefined)?.message;
          finish({ text: assembled, error: err || 'codex turn failed' });
        } else {
          finish({ text: assembled });
        }
        return;
      }

      const event = mapCodexNotification(method, params);
      if (!event) return;
      if (event.type === 'token' && typeof event.content === 'string') assembled += event.content;
      onEvent(event);
    });

    const onAbort = () => {
      if (turnId) void c.request('turn/interrupt', { threadId: tid, turnId }).catch(() => {});
      finish({ text: assembled });
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish({ text: '' });
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    c.request('turn/start', {
      threadId: tid,
      input: toUserInput(input),
      approvalPolicy: approvalPolicyNow(),
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspaceRoot()],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort && CODEX_EFFORTS.has(opts.effort) ? { effort: opts.effort } : {}),
    })
      .then((ack) => {
        const turn = ack.turn as Record<string, JsonValue> | undefined;
        if (turn && typeof turn.id === 'string') turnId = turn.id;
      })
      .catch((err) => {
        finish({ text: assembled, error: err instanceof Error ? err.message : String(err) });
      });
  });
}
