import {describe, expect, it} from 'vitest';
import {classifyEnvironmentMember, type EnvironmentReceipt} from '../src/lib/environmentState.js';
import {parseEnvironmentManifest} from '../src/lib/environmentManifest.js';
import {renderEnvExample} from '../src/lib/environmentExample.js';

const receipt: EnvironmentReceipt = {
  name: 'TOKEN',
  destination: '.runtime/service.env',
  mode: '0600',
  manifest_fingerprint: 'manifest-a',
  materialized_at: '2026-08-04T00:00:00.000Z',
  stat: {device: 1, inode: 2, mode: 0o600, mtime_ms: 100, ctime_ms: 100},
};
const currentStat = {exists: true as const, device: 1, inode: 2, mode: 0o600, mtime_ms: 100, ctime_ms: 100};

describe('environment state', () => {
  it('classifies all six value-free states [AC6]', () => {
    expect(classifyEnvironmentMember(undefined, {exists: false}, 'manifest-a')).toBe('absent');
    expect(classifyEnvironmentMember(undefined, currentStat, 'manifest-a')).toBe('unmanaged');
    expect(classifyEnvironmentMember({...receipt, manifest_fingerprint: undefined}, currentStat, 'manifest-a'))
      .toBe('managed_unknown_freshness');
    expect(classifyEnvironmentMember(receipt, currentStat, 'manifest-b')).toBe('managed_stale');
    expect(classifyEnvironmentMember(receipt, {...currentStat, mtime_ms: 101}, 'manifest-a')).toBe('modified_locally');
    expect(classifyEnvironmentMember(receipt, currentStat, 'manifest-a')).toBe('managed_current');
  });

  it('renders a deterministic names-and-placeholders-only example [AC8]', () => {
    const parsed = parseEnvironmentManifest(`
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: SECRET_TOKEN
    kind: vault_field
    owner: personal
    entry_id: 22222222-2222-4222-8222-222222222222
    field: token
    sensitivity: secret
    destination: {path: .runtime/service.env, mode: "0600"}
    documentation: Service token
  - name: ALPHA_PUBLIC
    kind: public
    sensitivity: public
    destination: {path: .runtime/service.env, mode: "0600"}
    placeholder: enabled
    documentation: Public switch
`);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const first = renderEnvExample(parsed.manifest);
    const second = renderEnvExample(parsed.manifest);
    expect(first).toBe(second);
    expect(first).toBe(`# Generated from .sift/environment.yaml (schema 1).\n# Names and documentation-safe placeholders only. Do not put secrets here.\n\n# Public switch\nALPHA_PUBLIC=<public:enabled>\n\n# Service token\nSECRET_TOKEN=<secret>\n`);
    expect(first).not.toContain('22222222-2222-4222-8222-222222222222');
  });
});
