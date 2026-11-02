import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Validator} from '@cfworker/json-schema';
import {describe, expect, it} from 'vitest';
import {parse} from 'yaml';
import {
  FORBIDDEN_MANIFEST_KEYS,
  parseEnvironmentManifest,
} from '../src/lib/environmentManifest.js';
import {authorizeManifestOwner, resolveManifestOwner} from '../src/lib/environmentOwner.js';

const validManifest = `
schema_version: 1
kind: sift.environment.contract
owners:
  personal:
    owner_type: personal
    owner_id: self
  production:
    owner_type: workspace
    owner_id: 11111111-1111-4111-8111-111111111111
members:
  - name: API_TOKEN
    kind: vault_field
    owner: production
    entry_id: 22222222-2222-4222-8222-222222222222
    field: token
    sensitivity: secret
    destination:
      path: .runtime/service.env
      mode: "0600"
    documentation: Service API token
  - name: LOG_LEVEL
    kind: public
    sensitivity: public
    destination:
      path: .runtime/service.env
      mode: "0600"
    placeholder: info
    documentation: Public log verbosity
`;

describe('environment manifest contract', () => {
  it('requires an explicit managed destination mode in parser and schema [AC6]', () => {
    const parsed = parseEnvironmentManifest(validManifest.replace('mode: "0600"', ''));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({path: '$.members[0].destination.mode'}),
    ]));

    const schemaPath = path.resolve(process.cwd(), '../../schemas/vault-environment-manifest.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const instance = parse(validManifest) as {members: Array<{destination: Record<string, unknown>}>};
    delete instance.members[0].destination.mode;
    expect(new Validator(schema, '2020-12', false).validate(instance).valid).toBe(false);
    expect(schema.$defs.destination.properties.mode.enum).toEqual(['0400', '0600']);
  });

  it('parses unknown YAML once into strict discriminated value-free types [AC1]', () => {
    const result = parseEnvironmentManifest(validManifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.schema_version).toBe(1);
    expect(result.manifest.members[0]).toEqual(expect.objectContaining({
      kind: 'vault_field',
      owner: 'production',
      entry_id: '22222222-2222-4222-8222-222222222222',
      field: 'token',
      sensitivity: 'secret',
      destination: {path: '.runtime/service.env', mode: '0600'},
    }));
    expect(result.manifest.members[1]).toEqual(expect.objectContaining({
      kind: 'public',
      sensitivity: 'public',
      placeholder: 'info',
    }));
    expect(JSON.stringify(result.manifest)).not.toMatch(/ciphertext|wrapped_key|secret_value/i);
  });

  it.each([
    ['ciphertext', 'portable ciphertext'],
    ['wrapped_key', 'wrapped keys'],
    ['encrypted_value', 'embedded encrypted values'],
    ['value_digest', 'value-derived digests'],
    ['write_to', 'generic destination-write capability'],
  ])('rejects %s as %s [AC2]', (key) => {
    const malicious = `${validManifest}\n${key}: forbidden\n`;
    const result = parseEnvironmentManifest(malicious);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'forbidden_key'}),
    ]));
  });

  it('rejects aliases, extra keys, invalid stable IDs, and non-public public members [AC1] [AC2]', () => {
    for (const raw of [
      `${validManifest}\ncopy: &value nope\nalias: *value\n`,
      validManifest.replace('entry_id: 22222222-2222-4222-8222-222222222222', 'entry_id: billing-token'),
      validManifest.replace('kind: public\n    sensitivity: public', 'kind: public\n    sensitivity: secret'),
      validManifest.replace('documentation: Service API token', 'documentation: Service API token\n    extra: nope'),
    ]) {
      expect(parseEnvironmentManifest(raw).ok).toBe(false);
    }
  });

  it('keeps the TypeScript and JSON Schema deny lists aligned [AC2]', () => {
    const schemaPath = path.resolve(process.cwd(), '../../schemas/vault-environment-manifest.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {'x-forbidden-property-names': string[]};
    expect(schema['x-forbidden-property-names']).toEqual([...FORBIDDEN_MANIFEST_KEYS]);
  });

  it.each([
    ['ciphertext', 'portable ciphertext'],
    ['wrapped_key', 'wrapped keys'],
    ['encrypted_value', 'encrypted values'],
    ['value_digest', 'value-derived digests'],
    ['write_capability', 'generic write capabilities'],
  ])('executes the JSON Schema and rejects %s as %s [AC2]', (key) => {
    const schemaPath = path.resolve(process.cwd(), '../../schemas/vault-environment-manifest.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const instance = parse(validManifest) as {members: Array<Record<string, unknown>>};
    instance.members[0][key] = 'forbidden';
    expect(new Validator(schema, '2020-12', false).validate(instance).valid).toBe(false);
  });

  it('executes the JSON Schema deny invariant for dynamic owner aliases [AC2]', () => {
    const schemaPath = path.resolve(process.cwd(), '../../schemas/vault-environment-manifest.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const instance = parse(validManifest) as {owners: Record<string, unknown>};
    instance.owners.ciphertext = instance.owners.personal;
    delete instance.owners.personal;
    expect(new Validator(schema, '2020-12', false).validate(instance).valid).toBe(false);
  });

  it('keeps published schema constraints aligned with runtime alias and documentation rules', () => {
    const schemaPath = path.resolve(process.cwd(), '../../schemas/vault-environment-manifest.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validator = new Validator(schema, '2020-12', false);
    const invalidAlias = parse(validManifest) as {owners: Record<string, unknown>};
    invalidAlias.owners['invalid alias'] = invalidAlias.owners.personal;
    delete invalidAlias.owners.personal;
    expect(validator.validate(invalidAlias).valid).toBe(false);

    const invalidDocumentation = parse(validManifest) as {members: Array<Record<string, unknown>>};
    invalidDocumentation.members[0].documentation = 'line one\nline two';
    expect(validator.validate(invalidDocumentation).valid).toBe(false);
  });
});

describe('environment owner resolution', () => {
  it('resolves canonical Personal and Workspace references without claiming a grant [AC9]', () => {
    const parsed = parseEnvironmentManifest(validManifest);
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(resolveManifestOwner('personal', parsed.manifest.owners)).toEqual({ok: true, owner: 'personal'});
    expect(resolveManifestOwner('production', parsed.manifest.owners))
      .toEqual({ok: true, owner: 'workspace:11111111-1111-4111-8111-111111111111'});
  });

  it('requires independent authoritative evidence before establishing a grant [AC9]', () => {
    const parsed = parseEnvironmentManifest(validManifest);
    if (!parsed.ok) throw new Error('fixture did not parse');
    const context = {
      kind: 'user' as const, owner: 'personal', workspaceId: null,
      contextContractVersion: 1 as const, selectionSource: 'test',
    };
    expect(resolveManifestOwner('workspace-name', parsed.manifest.owners)).toEqual({
      ok: false, code: 'ambiguous_bare_slug',
    });
    expect(resolveManifestOwner('undeclared', parsed.manifest.owners)).toEqual({
      ok: false, code: 'grant_not_established',
    });
    expect(authorizeManifestOwner('personal', parsed.manifest.owners, context)).toEqual({
      ok: false, code: 'grant_not_established',
    });
    expect(authorizeManifestOwner('personal', parsed.manifest.owners, context, {
      canonicalOwners: new Set(['workspace:11111111-1111-4111-8111-111111111111']),
    })).toEqual({ok: false, code: 'grant_not_established'});
    expect(authorizeManifestOwner('personal', parsed.manifest.owners, context, {
      canonicalOwners: new Set(['personal']),
    })).toEqual({ok: true, owner: 'personal'});
    expect(authorizeManifestOwner('production', parsed.manifest.owners, context, {
      canonicalOwners: new Set(['workspace:11111111-1111-4111-8111-111111111111']),
    })).toEqual({
      ok: false, code: 'owner_mismatch',
    });
  });
});
