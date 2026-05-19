export interface ParsedEntityRef {
  entityType: string;
  entityId: string;
  role?: string;
}

export function parseEntityRef(value: string): ParsedEntityRef {
  const [entityType, entityId, role] = value.split(':');
  if (!entityType || !entityId) {
    throw new Error(`Invalid entity reference "${value}". Use type:id or type:id:role.`);
  }
  return {entityType, entityId, role: role || undefined};
}

export function splitCsvFlag(value?: string): string[] | undefined {
  if (!value) return undefined;
  const tokens = value.split(',').map((token) => token.trim()).filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}
