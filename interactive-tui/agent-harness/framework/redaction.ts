const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)/iu;

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
      /("(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)"\s*:\s*")[^"]*(")/giu,
      `$1${REDACTED}$2`,
    )
    .replace(
      /((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
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
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeSensitiveValue(entry));
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([nestedKey, nested]) => [
        redactSensitiveText(nestedKey),
        sanitizeSensitiveValue(nested, nestedKey),
      ]),
  );
}
