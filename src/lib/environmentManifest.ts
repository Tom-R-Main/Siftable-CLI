import {isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit} from 'yaml';

export const FORBIDDEN_MANIFEST_KEYS = [
  'ciphertext',
  'wrapped_key',
  'encrypted_value',
  'value_digest',
  'secret_value',
  'plaintext',
  'private_key',
  'write_to',
  'write_capability',
  'destination_writer',
] as const;

const FORBIDDEN_KEY_PATTERN = /(?:cipher|encrypt|wrapped|sealed|plaintext|secret.?value|private.?key|value.?digest|checksum|fingerprint|hmac|write.?capability|destination.?writer|write.?to)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBER_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const PLACEHOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,63}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_LINES = 4096;

export type SensitivityClass = 'secret' | 'confidential' | 'public';
export type EnvironmentFileMode = '0400' | '0600';

export interface EnvironmentDestinationPolicy {
  path: string;
  mode: EnvironmentFileMode;
}

export interface PersonalEnvironmentOwner {
  owner_type: 'personal';
  owner_id: 'self';
}

export interface WorkspaceEnvironmentOwner {
  owner_type: 'workspace';
  owner_id: string;
}

export type EnvironmentOwner = PersonalEnvironmentOwner | WorkspaceEnvironmentOwner;

interface EnvironmentMemberBase {
  name: string;
  sensitivity: SensitivityClass;
  destination: EnvironmentDestinationPolicy;
  documentation?: string;
}

export interface VaultFieldEnvironmentMember extends EnvironmentMemberBase {
  kind: 'vault_field';
  owner: string;
  entry_id: string;
  field: string;
}

export interface PublicEnvironmentMember extends EnvironmentMemberBase {
  kind: 'public';
  sensitivity: 'public';
  placeholder: string;
}

export type EnvironmentMember = VaultFieldEnvironmentMember | PublicEnvironmentMember;

export interface EnvironmentManifest {
  schema_version: 1;
  kind: 'sift.environment.contract';
  owners: Record<string, EnvironmentOwner>;
  members: EnvironmentMember[];
}

export type ManifestIssueCode =
  | 'document_count'
  | 'forbidden_key'
  | 'invalid_yaml'
  | 'manifest_too_large'
  | 'schema_violation'
  | 'unsupported_yaml_feature';

export interface ManifestIssue {
  code: ManifestIssueCode;
  path: string;
  message: string;
}

export type EnvironmentManifestParseResult =
  | {ok: true; manifest: EnvironmentManifest}
  | {ok: false; issues: ManifestIssue[]};

function issue(code: ManifestIssueCode, path: string, message: string): ManifestIssue {
  return {code, path, message};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  issues: ManifestIssue[],
): boolean {
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue('schema_violation', `${path}.${key}`, 'Unknown manifest property'));
      valid = false;
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push(issue('schema_violation', `${path}.${key}`, 'Required manifest property is missing'));
      valid = false;
    }
  }
  return valid;
}

function scanForbiddenKeys(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((FORBIDDEN_MANIFEST_KEYS as readonly string[]).includes(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      issues.push(issue('forbidden_key', `${path}.${key}`, 'Value-bearing or write-capability properties are forbidden'));
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      issues.push(issue('forbidden_key', `${path}.${key}`, 'Prototype-affecting properties are forbidden'));
    }
    scanForbiddenKeys(child, `${path}.${key}`, issues);
  }
}

function parseDestination(value: unknown, path: string, issues: ManifestIssue[]): EnvironmentDestinationPolicy | null {
  if (!isRecord(value)) {
    issues.push(issue('schema_violation', path, 'destination must be an object'));
    return null;
  }
  exactKeys(value, ['path', 'mode'], ['path', 'mode'], path, issues);
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 1024) {
    issues.push(issue('schema_violation', `${path}.path`, 'destination.path must be a bounded string'));
  }
  if (value.mode !== '0400' && value.mode !== '0600') {
    issues.push(issue('schema_violation', `${path}.mode`, 'destination.mode must be 0400 or 0600'));
  }
  return typeof value.path === 'string' && (value.mode === '0400' || value.mode === '0600')
    ? {path: value.path, mode: value.mode}
    : null;
}

function parseOwner(value: unknown, path: string, issues: ManifestIssue[]): EnvironmentOwner | null {
  if (!isRecord(value)) {
    issues.push(issue('schema_violation', path, 'owner must be an object'));
    return null;
  }
  exactKeys(value, ['owner_type', 'owner_id'], ['owner_type', 'owner_id'], path, issues);
  if (value.owner_type === 'personal' && value.owner_id === 'self') {
    return {owner_type: 'personal', owner_id: 'self'};
  }
  if (value.owner_type === 'workspace' && typeof value.owner_id === 'string' && UUID_PATTERN.test(value.owner_id)) {
    return {owner_type: 'workspace', owner_id: value.owner_id.toLowerCase()};
  }
  issues.push(issue('schema_violation', path, 'owner_type and owner_id must be canonical Personal or Workspace identity'));
  return null;
}

function optionalDocumentation(value: unknown, path: string, issues: ManifestIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 240 || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    issues.push(issue('schema_violation', path, 'documentation must be a single printable line of at most 240 characters'));
    return undefined;
  }
  return value;
}

function parseMember(value: unknown, index: number, issues: ManifestIssue[]): EnvironmentMember | null {
  const memberPath = `$.members[${index}]`;
  if (!isRecord(value)) {
    issues.push(issue('schema_violation', memberPath, 'member must be an object'));
    return null;
  }
  const baseAllowed = ['name', 'kind', 'sensitivity', 'destination', 'documentation'];
  const required = ['name', 'kind', 'sensitivity', 'destination'];
  if (value.kind === 'vault_field') {
    exactKeys(value, [...baseAllowed, 'owner', 'entry_id', 'field'], [...required, 'owner', 'entry_id', 'field'], memberPath, issues);
  } else if (value.kind === 'public') {
    exactKeys(value, [...baseAllowed, 'placeholder'], [...required, 'placeholder'], memberPath, issues);
  } else {
    exactKeys(value, [...baseAllowed, 'owner', 'entry_id', 'field', 'placeholder'], required, memberPath, issues);
    issues.push(issue('schema_violation', `${memberPath}.kind`, 'member.kind must be vault_field or public'));
    return null;
  }

  if (typeof value.name !== 'string' || !MEMBER_NAME_PATTERN.test(value.name)) {
    issues.push(issue('schema_violation', `${memberPath}.name`, 'name must be an uppercase environment name'));
  }
  if (!['secret', 'confidential', 'public'].includes(String(value.sensitivity))) {
    issues.push(issue('schema_violation', `${memberPath}.sensitivity`, 'invalid sensitivity class'));
  }
  const destination = parseDestination(value.destination, `${memberPath}.destination`, issues);
  const documentation = optionalDocumentation(value.documentation, `${memberPath}.documentation`, issues);
  if (typeof value.name !== 'string' || !MEMBER_NAME_PATTERN.test(value.name) || !destination) return null;

  if (value.kind === 'vault_field') {
    if (typeof value.owner !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.owner)) {
      issues.push(issue('schema_violation', `${memberPath}.owner`, 'owner must reference a declared owner alias'));
    }
    if (typeof value.entry_id !== 'string' || !UUID_PATTERN.test(value.entry_id)) {
      issues.push(issue('schema_violation', `${memberPath}.entry_id`, 'entry_id must be a stable Vault UUID, not a slug'));
    }
    if (typeof value.field !== 'string' || !FIELD_NAME_PATTERN.test(value.field)) {
      issues.push(issue('schema_violation', `${memberPath}.field`, 'field must be an exact bounded field name'));
    }
    if (value.sensitivity !== 'secret' && value.sensitivity !== 'confidential') {
      issues.push(issue('schema_violation', `${memberPath}.sensitivity`, 'Vault fields must be secret or confidential'));
    }
    if (typeof value.owner !== 'string' || typeof value.entry_id !== 'string' || !UUID_PATTERN.test(value.entry_id)
      || typeof value.field !== 'string' || !FIELD_NAME_PATTERN.test(value.field)
      || (value.sensitivity !== 'secret' && value.sensitivity !== 'confidential')) return null;
    return {
      name: value.name,
      kind: 'vault_field',
      owner: value.owner,
      entry_id: value.entry_id.toLowerCase(),
      field: value.field,
      sensitivity: value.sensitivity,
      destination,
      ...(documentation === undefined ? {} : {documentation}),
    };
  }

  if (value.sensitivity !== 'public') {
    issues.push(issue('schema_violation', `${memberPath}.sensitivity`, 'public members must have public sensitivity'));
  }
  if (typeof value.placeholder !== 'string' || !PLACEHOLDER_PATTERN.test(value.placeholder)) {
    issues.push(issue('schema_violation', `${memberPath}.placeholder`, 'placeholder must be short documentation-safe text'));
  }
  if (value.sensitivity !== 'public' || typeof value.placeholder !== 'string' || !PLACEHOLDER_PATTERN.test(value.placeholder)) return null;
  return {
    name: value.name,
    kind: 'public',
    sensitivity: 'public',
    destination,
    placeholder: value.placeholder,
    ...(documentation === undefined ? {} : {documentation}),
  };
}

export function parseEnvironmentManifest(raw: unknown): EnvironmentManifestParseResult {
  if (typeof raw !== 'string') {
    return {ok: false, issues: [issue('invalid_yaml', '$', 'Manifest input must be YAML text')]};
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES || raw.split('\n').length > MAX_MANIFEST_LINES) {
    return {ok: false, issues: [issue('manifest_too_large', '$', 'Manifest exceeds the offline parser limits')]};
  }

  let documents;
  try {
    documents = parseAllDocuments(raw, {version: '1.2', schema: 'core', merge: false, uniqueKeys: true});
  } catch (error) {
    return {ok: false, issues: [issue('invalid_yaml', '$', error instanceof Error ? error.message : 'Invalid YAML')]};
  }
  if (documents.length !== 1) {
    return {ok: false, issues: [issue('document_count', '$', 'Exactly one YAML document is required')]};
  }
  const document = documents[0];
  const parseIssues: ManifestIssue[] = [
    ...document.errors.map(error => issue('invalid_yaml', '$', error.message)),
    ...document.warnings.map(error => issue('unsupported_yaml_feature', '$', error.message)),
  ];
  if (document.contents) {
    visit(document.contents, (_key, node) => {
      if (isAlias(node)) {
        parseIssues.push(issue('unsupported_yaml_feature', '$', 'YAML aliases are forbidden'));
        return visit.BREAK;
      }
      if ((isMap(node) || isSeq(node) || isScalar(node)) && node.tag && !node.tag.startsWith('tag:yaml.org,2002:')) {
        parseIssues.push(issue('unsupported_yaml_feature', '$', 'Custom YAML tags are forbidden'));
        return visit.BREAK;
      }
      return undefined;
    });
  }
  if (parseIssues.length > 0) return {ok: false, issues: parseIssues};

  let unknownValue: unknown;
  try {
    unknownValue = document.toJS({maxAliasCount: 0, mapAsMap: false});
  } catch (error) {
    return {ok: false, issues: [issue('invalid_yaml', '$', error instanceof Error ? error.message : 'Invalid YAML value')]};
  }
  const issues: ManifestIssue[] = [];
  scanForbiddenKeys(unknownValue, '$', issues);
  if (!isRecord(unknownValue)) {
    issues.push(issue('schema_violation', '$', 'Manifest root must be an object'));
    return {ok: false, issues};
  }
  exactKeys(unknownValue, ['schema_version', 'kind', 'owners', 'members'], ['schema_version', 'kind', 'owners', 'members'], '$', issues);
  if (unknownValue.schema_version !== 1) issues.push(issue('schema_violation', '$.schema_version', 'schema_version must be 1'));
  if (unknownValue.kind !== 'sift.environment.contract') issues.push(issue('schema_violation', '$.kind', 'unsupported manifest kind'));

  const owners: Record<string, EnvironmentOwner> = Object.create(null) as Record<string, EnvironmentOwner>;
  if (!isRecord(unknownValue.owners) || Object.keys(unknownValue.owners).length === 0) {
    issues.push(issue('schema_violation', '$.owners', 'owners must be a non-empty object'));
  } else {
    for (const [alias, ownerValue] of Object.entries(unknownValue.owners)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias)) {
        issues.push(issue('schema_violation', `$.owners.${alias}`, 'owner alias is invalid'));
        continue;
      }
      const owner = parseOwner(ownerValue, `$.owners.${alias}`, issues);
      if (owner) owners[alias] = owner;
    }
  }

  const members: EnvironmentMember[] = [];
  if (!Array.isArray(unknownValue.members) || unknownValue.members.length === 0 || unknownValue.members.length > 512) {
    issues.push(issue('schema_violation', '$.members', 'members must be a bounded non-empty array'));
  } else {
    unknownValue.members.forEach((member, index) => {
      const parsed = parseMember(member, index, issues);
      if (parsed) members.push(parsed);
    });
  }
  const duplicateNames = members.map(member => member.name).filter((name, index, all) => all.indexOf(name) !== index);
  for (const name of duplicateNames) issues.push(issue('schema_violation', '$.members', `Duplicate member name: ${name}`));
  for (const member of members) {
    if (member.kind === 'vault_field' && !owners[member.owner]) {
      issues.push(issue('schema_violation', `$.members.${member.name}.owner`, 'Member owner must reference the owners block'));
    }
  }
  if (issues.length > 0) return {ok: false, issues};
  return {
    ok: true,
    manifest: {schema_version: 1, kind: 'sift.environment.contract', owners, members},
  };
}
