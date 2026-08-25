const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /^(?:(?:[a-z0-9]+_)*)(?:authorization|cookie|password|passwd|passphrase|password_hash|secret|token|token_hash|credential|credentials|api_key|access_key(?:_id)?|private_key|client_secret|access_token|refresh_token|id_token|session_token)(?:_header)?(?:_value)?$/u;

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

function redactStructuredAssignment(
  match: string,
  prefix: string,
  quote: string,
  key: string,
  separator: string,
  assignedValue: string,
): string {
  if (!isSensitiveKey(key)) return match;
  const valueQuote = assignedValue.startsWith("\"") || assignedValue.startsWith("'")
    ? assignedValue.charAt(0)
    : "";
  const replacement = valueQuote ? `${valueQuote}${REDACTED}${valueQuote}` : REDACTED;
  return `${prefix}${quote}${key}${quote}${separator}${replacement}`;
}

/** Redact high-confidence credential shapes without discarding ordinary output. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
      REDACTED,
    )
    .replace(/(bearer\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(
      /([?&](?:token|key|secret|signature|credential|password)=)[^&\s]+/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /(^|[\s,{;])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)("(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s,;]+)/gimu,
      redactStructuredAssignment,
    )
    .replace(
      /(^\s*(?:authorization|proxy[-_ ]authorization|cookie|set[-_ ]cookie)\s*:\s*).*$/gimu,
      `$1${REDACTED}`,
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sift_pat_[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/gu,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED,
    )
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/giu, `$1${REDACTED}@`);
}

/** Recursively redact sensitive keys and credential-shaped strings. */
export function sanitizeSensitiveValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeSensitiveValue(entry));
  if (typeof value !== "object") return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([mapKey, mapValue]) => [
      sanitizeSensitiveValue(mapKey),
      sanitizeSensitiveValue(mapValue, typeof mapKey === "string" ? mapKey : undefined),
    ]);
  }
  if (value instanceof Set) {
    return [...value.values()].map((entry) => sanitizeSensitiveValue(entry));
  }
  if (value instanceof URL || value instanceof RegExp) {
    return redactSensitiveText(value.toString());
  }
  if (value instanceof Error) {
    return {
      name: redactSensitiveText(value.name),
      message: redactSensitiveText(value.message),
      ...(value.stack === undefined ? {} : { stack: redactSensitiveText(value.stack) }),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 0) {
    return Object.fromEntries(
      entries.map(([nestedKey, nested]) => [
        redactSensitiveText(nestedKey),
        sanitizeSensitiveValue(nested, nestedKey),
      ]),
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return {};
  const constructorName = typeof prototype?.constructor?.name === "string"
    ? prototype.constructor.name
    : "Object";
  return `[${redactSensitiveText(constructorName)}]`;
}
