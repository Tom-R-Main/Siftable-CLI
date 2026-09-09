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
  const maxAttempts = bounded(config.retry?.maxAttempts, 3, 1, 5);
  const baseDelayMs = bounded(config.retry?.baseDelayMs, 500, 0, 60_000);
  const maxDelayMs = bounded(config.retry?.maxDelayMs, 30_000, 0, 300_000);

  function finish(data: unknown = latestData, outcome: ProviderReceipt["outcome"] = "completed") {
    if (settled) return;
    settled = true;
    const body = record(data);
    const receipt: ProviderReceipt = {
      requestId, provider: config.name ?? "Compatible API", requestedModel: config.model ?? "unknown",
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
          emit({ type: "provider.attempt", requestId, attempt: attempts + 1, provider: config.name ?? "Compatible API", requestedModel: config.model ?? "unknown", oneShot: options?.oneShot === true, mode: stream ? "streaming" : "buffered" });
          signal?.throwIfAborted();
          attempts += 1;
          // Only explicit HTTP rejection is retried. Network failures and interrupted
          // successful streams have unknown generation outcomes and are never replayed.
          lastResponse = undefined;
          lastResponse = await (config.fetchImpl ?? fetch)(url, { ...init, signal, redirect: "error" });
          signal?.throwIfAborted();
          terminalError = terminalGatewayError(lastResponse);
          if (terminalError) {
            await lastResponse.body?.cancel().catch(() => {});
            signal?.throwIfAborted();
            throw terminalError;
          }
          if (lastResponse.status !== 429 && ![500, 502, 503, 504, 529].includes(lastResponse.status)) return lastResponse;
          if (attempts >= maxAttempts) return lastResponse;
          const headerDelay = retryAfterMs(lastResponse.headers?.get("retry-after"));
          const delayMs = Math.max(headerDelay ?? 0, Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1)));
          if (delayMs > maxDelayMs) return lastResponse;
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

export async function readProviderResponse(response: Response, protocol: "chat" | "responses", text: (delta: string) => void, signal?: AbortSignal, capture?: (data: unknown) => void): Promise<unknown> {
  if (!response.headers?.get("content-type")?.includes("text/event-stream")) return response.json();
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let content = "";
  let finishReason: string | undefined;
  let metadata: Record<string, unknown> = {};
  for await (const raw of serverEvents(response, signal)) {
    if (raw === "[DONE]") {
      if (protocol !== "chat" || !finishReason) throw new Error("Provider stream ended without a completed response");
      if (!["stop", "tool_calls", "function_call"].includes(finishReason)) throw new Error(`Provider response incomplete (${finishReason})`);
      return { ...metadata, choices: [{ finish_reason: finishReason, message: { role: "assistant", content, ...(calls.size ? { tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) } }] };
    }
    const event = record(JSON.parse(raw));
    if (protocol === "responses" && event.response) capture?.(event.response);
    if (protocol === "chat") {
      for (const key of ["id", "model", "usage"]) if (event[key] !== undefined && event[key] !== null) metadata[key] = event[key];
      capture?.(metadata);
    }
    if (event.error || event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw new Error("Provider stream reported a failed or incomplete response");
    if (protocol === "responses") {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") text(event.delta);
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
