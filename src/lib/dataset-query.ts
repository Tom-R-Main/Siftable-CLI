export function parseJsonArrayFlag(value: string | undefined, label: string): Array<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed as Array<Record<string, unknown>>;
}

export function splitFields(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const fields = value.split(',').map((field) => field.trim()).filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

export function mergeFilters(
  base: Array<Record<string, unknown>> | undefined,
  extra: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [...(base ?? []), extra];
}
