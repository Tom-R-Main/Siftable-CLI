export function parseStringMap(value: string, label: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || !Object.values(parsed).every(item => typeof item === 'string')) {
    throw new Error(`${label} must be a JSON object with string values`);
  }
  return parsed as Record<string, string>;
}
