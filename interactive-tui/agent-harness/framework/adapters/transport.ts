import { randomUUID } from "node:crypto";
import type { AdapterConfig, AdapterEvent, ChatOptions, ProviderErrorCode, ProviderReceipt, ProviderUsage } from "./types.js";
import { PROVIDER_TERMINAL_ERROR_CODES } from "./types.js";

const TERMINAL_GATEWAY_ERRORS: Record<ProviderErrorCode, string> = {
  gateway_attempt_limit: "Gateway attempt budget exhausted",
  gateway_spend_limit: "Gateway spending budget exhausted",
  gateway_ledger_limit: "Gateway shared budget exhausted",
  gateway_ledger_unavailable: "Gateway budget ledger unavailable",
  gateway_deadline: "Gateway deadline reached",
  gateway_revoked: "Gateway admission revoked",
};

/** Safe machine-readable terminal failure; arbitrary provider messages are never copied. */
export class ProviderRequestError extends Error {
  readonly retryable = false;
  constructor(readonly code: ProviderErrorCode, readonly status: number) {
    super(TERMINAL_GATEWAY_ERRORS[code]);
    this.name = "ProviderRequestError";
  }
}

/** Non-OK HTTP reply from the provider; status only, never the body. */
export class ProviderHttpError extends Error {
  constructor(readonly provider: string, readonly status: number) {
    super(`${provider} API error (${status})`);
    this.name = "ProviderHttpError";
  }
}

/** The provider ended a response early (finish_reason other than stop/tool call). A
 * response with no visible output at all (reasoning consumed the cap) is retryable
 * once or twice by the caller; one with partial visible output is not replayed. */
export class ProviderIncompleteError extends Error {
  constructor(readonly provider: string, readonly finishReason: string, readonly visibleOutput: boolean) {
    super(`${provider} response incomplete (${finishReason})`);
    this.name = "ProviderIncompleteError";
  }
}

/** The provider stopped making progress. The generation outcome is unknown, so this is never replayed. */
export class ProviderStallError extends Error {
  readonly retryable = false;
  constructor(readonly provider: string, readonly phase: "headers" | "body", readonly elapsedMs: number) {
    super(`${provider} API stalled: no ${phase === "headers" ? "response headers" : "response data"} for ${elapsedMs}ms`);
    this.name = "ProviderStallError";
  }
}

export function reasoningOnlyTruncation(error: unknown): error is ProviderIncompleteError {
  return error instanceof ProviderIncompleteError && error.finishReason === "length" && !error.visibleOutput;
}

function terminalGatewayError(response: Response): ProviderRequestError | undefined {
  const code = response.headers?.get("x-sift-error-code");
  if (!response.ok && response.headers?.get("x-sift-error-retryable") === "false" &&
      code && (PROVIDER_TERMINAL_ERROR_CODES as readonly string[]).includes(code)) {
    return new ProviderRequestError(code as ProviderErrorCode, response.status);
  }
  return undefined;
}

/** Reject credential-bearing URLs before they can enter request errors or fingerprints. */
export function compatibleBaseUrl(value: string): string {
  const url = new URL(value);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider base URL must be an HTTP(S) API root without credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export function outputTokenLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 131_072)) {
    throw new Error("maxOutputTokens must be an integer between 1 and 131072");
  }
  return value;
}

/** One instance per logical generation, including one-shot and recovery generations. */
export function providerTransport(config: Partial<AdapterConfig>, options: ChatOptions | undefined, supportsStreaming = true) {
  const requestId = randomUUID();
  const observer = options?.onEvent ?? config.onEvent;
  // Observers may enforce durable journaling. A failed write must stop dispatch;
  // it is never a provider failure eligible for retry.
  let observerFailed = false;
  let observerError: unknown;
  const emit = (event: AdapterEvent) => {
    if (observerFailed) return;
    try { observer?.(event); } catch (error) { observerFailed = true; observerError = error; throw error; }
  };
  const stream = supportsStreaming && (options?.stream ?? Boolean(observer));
  let attempts = 0;
  let settled = false;
  let lastResponse: Response | undefined;
  let latestData: unknown;
  let terminalError: ProviderRequestError | undefined;
  const receipts: ProviderReceipt[] = [];
  const signal = options?.signal;
  const provider = config.name ?? "Compatible API";
  const maxAttempts = bounded(config.retry?.maxAttempts, 3, 1, 5);
  const baseDelayMs = bounded(config.retry?.baseDelayMs, 500, 0, 60_000);
  const maxDelayMs = bounded(config.retry?.maxDelayMs, 30_000, 0, 300_000);
  const headersMs = bounded(config.timeouts?.headersMs, 120_000, 0, 600_000);
  const idleMs = bounded(config.timeouts?.idleMs, 60_000, 0, 600_000);
  const random = config.randomImpl ?? Math.random;
  // The request signal composes the caller's cancellation with the stall
  // watchdogs. Caller aborts forward their own reason so cancellation stays
  // authoritative; a stall aborts with a ProviderStallError while the caller
  // signal stays quiet, which is what classifies the receipt as failed rather
  // than cancelled. Composed by hand: the packaged CLI runs under Node and
  // must not depend on AbortSignal.any.
  const internal = new AbortController();
  const forwardAbort = () => internal.abort(signal?.reason ?? new Error("Request cancelled"));
  if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
  const stall = (phase: "headers" | "body", elapsedMs: number): ProviderStallError => {
    const error = new ProviderStallError(provider, phase, elapsedMs);
    if (!internal.signal.aborted) internal.abort(error);
    return error;
  };

  function finish(data: unknown = latestData, outcome: ProviderReceipt["outcome"] = "completed") {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", forwardAbort);
    const body = record(data);
    const receipt: ProviderReceipt = {
      requestId, provider, requestedModel: config.model ?? "unknown",
      attempts, mode: lastResponse?.headers?.get("content-type")?.includes("text/event-stream") ? "streaming" : "buffered",
      outcome, ...(lastResponse ? { status: lastResponse.status } : {}),
      ...(typeof body.model === "string" ? { servedModel: body.model } : {}),
      ...(typeof body.id === "string" ? { responseId: body.id } : {}),
      ...(lastResponse?.headers?.get("x-request-id") || lastResponse?.headers?.get("request-id")
        ? { providerRequestId: (lastResponse.headers?.get("x-request-id") ?? lastResponse.headers?.get("request-id"))! } : {}),
      ...(body.usage ? { usage: normalizedUsage(body.usage) } : {}),
      ...(terminalError ? { error: { code: terminalError.code, retryable: false as const } } : {}),
    };
    receipts.push(receipt);
    emit({ type: "provider.response", receipt });
  }

  return {
    stream, receipts,
    text(delta: string) { if (delta) emit({ type: "provider.text.delta", requestId, delta }); },
    finish,
    throwIfObserverFailed() { if (observerFailed) throw observerError; },
    throwIfTerminalFailed() { signal?.throwIfAborted(); if (terminalError) throw terminalError; },
    capture(data: unknown) { latestData = data; },
    fail() { finish(undefined, signal?.aborted ? "cancelled" : "failed"); },
    async fetch(url: string, init: RequestInit): Promise<Response> {
      try {
        while (true) {
          signal?.throwIfAborted();
          emit({ type: "provider.attempt", requestId, attempt: attempts + 1, provider, requestedModel: config.model ?? "unknown", oneShot: options?.oneShot === true, mode: stream ? "streaming" : "buffered" });
          signal?.throwIfAborted();
          attempts += 1;
          // Only explicit HTTP rejection is retried. Network failures, stalls and
          // interrupted successful streams have unknown generation outcomes and are
          // never replayed: missing headers do not prove generation never started —
          // a buffered or proxied provider may already be generating, and a retry
          // would risk duplicate side effects.
          lastResponse = undefined;
          const headerTimer = headersMs > 0 ? setTimeout(() => stall("headers", headersMs), headersMs) : undefined;
          try {
            lastResponse = await (config.fetchImpl ?? fetch)(url, { ...init, signal: internal.signal, redirect: "error" });
          } finally {
            clearTimeout(headerTimer);
          }
          signal?.throwIfAborted();
          internal.signal.throwIfAborted();
          terminalError = terminalGatewayError(lastResponse);
          if (terminalError) {
            await lastResponse.body?.cancel().catch(() => {});
            signal?.throwIfAborted();
            throw terminalError;
          }
          const retryable = lastResponse.status === 429 || [500, 502, 503, 504, 529].includes(lastResponse.status);
          if (!retryable || attempts >= maxAttempts) return (lastResponse = withIdleWatchdog(lastResponse, idleMs, (elapsed) => stall("body", elapsed)));
          const headerDelay = retryAfterMs(lastResponse.headers?.get("retry-after"));
          // Jitter applies to the local backoff only; the server's Retry-After is a
          // floor applied afterwards and can never be shortened by it.
          const local = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
          const jittered = local === 0 ? 0 : Math.round(local / 2 + random() * (local / 2));
          const delayMs = Math.max(headerDelay ?? 0, jittered);
          if (delayMs > maxDelayMs) return (lastResponse = withIdleWatchdog(lastResponse, idleMs, (elapsed) => stall("body", elapsed)));
          await lastResponse.body?.cancel();
          emit({ type: "provider.retry", requestId, attempt: attempts, status: lastResponse.status, delayMs });
          await cancellableDelay(delayMs, signal);
        }
      } catch (error) {
        if (signal?.aborted) await lastResponse?.body?.cancel().catch(() => {});
        finish(undefined, signal?.aborted ? "cancelled" : "failed");
        throw error;
      }
    },
  };
}

/**
 * Idle watchdog over a response body. Pull-based so the timer runs only while a
 * read is pending and is always cleared when that read settles; a stall cancels
 * the upstream reader so the pending read rejects with the stall reason. Wraps
 * every consumer uniformly: SSE framing, buffered `.json()`, and SDKs handed
 * `transport.fetch` all see the same behavior.
 */
function withIdleWatchdog(response: Response, idleMs: number, onStall: (elapsedMs: number) => ProviderStallError): Response {
  if (!response.body || idleMs <= 0) return response;
  const reader = response.body.getReader();
  let stalled: ProviderStallError | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => {
        stalled = onStall(idleMs);
        // Cancelling settles the pending read (as done, not rejected); the
        // `stalled` flag turns that into the stall error below.
        void reader.cancel(stalled).catch(() => {});
      }, idleMs);
      try {
        const { done, value } = await reader.read();
        if (stalled) controller.error(stalled);
        else if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(stalled ?? error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) { return reader.cancel(reason).catch(() => {}); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : fallback;
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null || value.length > 160 || /[\r\n]/.test(value)) return undefined;
  const text = value.trim();
  const milliseconds = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : NaN;
  if (Number.isFinite(milliseconds)) return Math.ceil(milliseconds);
  const date = Date.parse(text);
  return Number.isFinite(date) && new Date(date).toUTCString() === text ? Math.max(0, date - now) : undefined;
}

async function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(signal?.reason ?? new Error("Request cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export function normalizedUsage(value: unknown): ProviderUsage {
  const usage = record(value);
  const inputDetails = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const result: ProviderUsage = {};
  const fields = {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    cachedInputTokens: inputDetails.cached_tokens ?? usage.cache_read_input_tokens,
    totalTokens: usage.total_tokens,
  };
  for (const [key, amount] of Object.entries(fields)) {
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) result[key as keyof ProviderUsage] = amount;
  }
  return result;
}

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Incremental SSE framing, including split UTF-8, CRLF, comments and multiline data. */
export async function* serverEvents(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let dataBytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") { if (data.length) yield data.join("\n"); data = []; dataBytes = 0; }
        else if (line.startsWith("data:")) {
          dataBytes += line.length;
          if (dataBytes > 8 * 1024 * 1024) throw new Error("Provider stream event exceeds 8 MiB");
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Provider stream event exceeds 8 MiB");
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Visible output in a Responses API result: any message text, a refusal, or a function call. */
export function responsesVisibleOutput(response: unknown): boolean {
  const output = record(response).output;
  if (!Array.isArray(output)) return false;
  return output.some((item: any) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "function_call") return true;
    if (item.type !== "message" || !Array.isArray(item.content)) return false;
    return item.content.some((part: any) => part
      && ((part.type === "output_text" && typeof part.text === "string" && part.text.length > 0)
        || (part.type === "refusal" && typeof part.refusal === "string" && part.refusal.length > 0)));
  });
}

export async function readProviderResponse(response: Response, protocol: "chat" | "responses", text: (delta: string) => void, signal?: AbortSignal, capture?: (data: unknown) => void): Promise<unknown> {
  if (!response.headers?.get("content-type")?.includes("text/event-stream")) return response.json();
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let content = "";
  let finishReason: string | undefined;
  let metadata: Record<string, unknown> = {};
  let responsesVisible = false;
  for await (const raw of serverEvents(response, signal)) {
    if (raw === "[DONE]") {
      if (protocol !== "chat" || !finishReason) throw new Error("Provider stream ended without a completed response");
      if (!["stop", "tool_calls", "function_call"].includes(finishReason)) throw new ProviderIncompleteError("Provider", finishReason, content.length > 0 || calls.size > 0);
      return { ...metadata, choices: [{ finish_reason: finishReason, message: { role: "assistant", content, ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) } }] };
    }
    const event = record(JSON.parse(raw));
    if (protocol === "responses" && event.response) capture?.(event.response);
    if (protocol === "chat") {
      for (const key of ["id", "model", "usage"]) if (event[key] !== undefined && event[key] !== null) metadata[key] = event[key];
      capture?.(metadata);
    }
    if (event.type === "response.incomplete") {
      // Only an output-token cap is a replayable truncation (CLI-045); every
      // other incomplete reason stays terminal.
      const reason = record(record(event.response).incomplete_details).reason;
      if (reason === "max_output_tokens") {
        throw new ProviderIncompleteError("Provider", "length", responsesVisible || responsesVisibleOutput(event.response));
      }
      throw new Error("Provider stream reported a failed or incomplete response");
    }
    if (event.error || event.type === "error" || event.type === "response.failed") throw new Error("Provider stream reported a failed or incomplete response");
    if (protocol === "responses") {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        if (event.delta.length > 0) responsesVisible = true;
        text(event.delta);
      }
      // A refusal is rendered as assistant text by the parser, so it is visible
      // output and is delivered like text: a truncated refusal must still reach
      // the listener before the incomplete event ends the stream.
      if (event.type === "response.refusal.delta" && typeof event.delta === "string" && event.delta.length > 0) {
        responsesVisible = true;
        text(event.delta);
      }
      if (event.type === "response.output_item.added" && record(event.item).type === "function_call") responsesVisible = true;
      if (event.type === "response.completed") {
        if (record(event.response).status !== "completed") throw new Error("Provider response is not completed");
        return event.response;
      }
      continue;
    }
    const choice = record(Array.isArray(event.choices) ? event.choices.find((item: any) => item.index === 0 || item.index === undefined) : undefined);
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = record(choice.delta);
    if (typeof delta.content === "string") { content += delta.content; text(delta.content); }
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const callDelta = record(rawCall);
      if (!Number.isInteger(callDelta.index) || callDelta.index < 0) throw new Error("Provider stream tool call index is invalid");
      const call = calls.get(callDelta.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (typeof callDelta.id === "string") call.id = callDelta.id;
      if (callDelta.type !== undefined && callDelta.type !== "function") throw new Error("Unsupported provider stream tool call type");
      const fn = record(callDelta.function);
      if (typeof fn.name === "string") call.function.name += fn.name;
      if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
      calls.set(callDelta.index, call);
    }
  }
  throw new Error("Provider stream ended before its terminal event; partial tool calls were discarded");
}
