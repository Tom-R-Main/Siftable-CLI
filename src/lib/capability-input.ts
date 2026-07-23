export function parseJsonObject(value: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flagName} must be a JSON object`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseCsvIdentifiers(value: string): string[] {
  const items = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
  if (items.length === 0) {
    throw new Error('--operation must contain at least one operation');
  }
  return items;
}
