import {
  forgetProviderKey,
  providerKeychainAvailable,
  recallProviderKey,
  rememberProviderKey,
  type KeychainRunner,
} from '../../interactive-tui/providerKeychain';

function runnerFor(responses: Array<{ code: number | null; stdout: string }>): {
  run: KeychainRunner;
  calls: Array<{ exe: string; args: string[]; stdin?: string }>;
} {
  const calls: Array<{ exe: string; args: string[]; stdin?: string }> = [];
  let i = 0;
  const run: KeychainRunner = (exe, args, stdin) => {
    calls.push({ exe, args, stdin });
    const next = responses[Math.min(i++, responses.length - 1)];
    return { ...next, timedOut: false };
  };
  return { run, calls };
}

describe('providerKeychainAvailable', () => {
  it('is available on macOS without probing', () => {
    expect(providerKeychainAvailable('darwin', () => { throw new Error('must not probe'); })).toBe(true);
  });

  it('checks for secret-tool on Linux', () => {
    expect(providerKeychainAvailable('linux', () => true)).toBe(true);
    expect(providerKeychainAvailable('linux', () => false)).toBe(false);
  });

  it('is unavailable elsewhere', () => {
    expect(providerKeychainAvailable('win32', () => true)).toBe(false);
  });
});

describe('recallProviderKey', () => {
  it('reads macOS keychain entries via security', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: 'sk-secret\n' }]);
    expect(recallProviderKey('META_API_KEY', { platform: 'darwin', run })).toBe('sk-secret');
    expect(calls[0].exe).toBe('security');
    expect(calls[0].args).toContain('META_API_KEY');
    expect(calls[0].args).not.toContain('sk-secret');
  });

  it('reads Linux entries via secret-tool', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: 'sk-secret\n' }]);
    expect(recallProviderKey('OPENROUTER_API_KEY', { platform: 'linux', run, available: true })).toBe('sk-secret');
    expect(calls[0].exe).toBe('/usr/bin/secret-tool');
  });

  it('returns null for missing entries and unsupported platforms', () => {
    const missing = runnerFor([{ code: 44, stdout: '' }]);
    expect(recallProviderKey('META_API_KEY', { platform: 'darwin', run: missing.run })).toBeNull();
    const empty = runnerFor([{ code: 0, stdout: '\n' }]);
    expect(recallProviderKey('META_API_KEY', { platform: 'darwin', run: empty.run })).toBeNull();
    const never = runnerFor([{ code: 0, stdout: 'x' }]);
    expect(recallProviderKey('META_API_KEY', { platform: 'win32', run: never.run })).toBeNull();
    expect(never.calls).toHaveLength(0);
  });

  it('rejects non-env-var accounts without touching the keychain', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: 'x' }]);
    expect(() => recallProviderKey('../../evil', { platform: 'darwin', run })).toThrow();
    expect(() => recallProviderKey('META_API_KEY; rm -rf ~', { platform: 'darwin', run })).toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('rememberProviderKey', () => {
  it('upserts macOS entries over stdin, never argv', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: '' }]);
    rememberProviderKey('META_API_KEY', 'sk-secret', { platform: 'darwin', run, available: true });
    expect(calls[0].exe).toBe('security');
    expect(calls[0].args).toEqual(['-i']);
    expect(calls[0].args.join(' ')).not.toContain('sk-secret');
    expect(calls[0].stdin).toContain('add-generic-password');
    expect(calls[0].stdin).toContain('META_API_KEY');
  });

  it('rejects non-token secrets without touching the keychain', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: '' }]);
    for (const bad of ['has space', 'two\nlines', 'x'.repeat(513)]) {
      expect(() => rememberProviderKey('META_API_KEY', bad, { platform: 'darwin', run, available: true }))
        .toThrow('single-line token');
    }
    expect(calls).toHaveLength(0);
  });

  it('pipes Linux entries over stdin, never argv', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: '' }]);
    rememberProviderKey('META_API_KEY', 'sk-secret', { platform: 'linux', run, available: true });
    expect(calls[0].exe).toBe('/usr/bin/secret-tool');
    expect(calls[0].args.join(' ')).not.toContain('sk-secret');
    expect(calls[0].stdin).toBe('sk-secret\n');
  });

  it('throws value-free errors for empty secrets, refusals, and bad platforms', () => {
    const { run } = runnerFor([{ code: 0, stdout: '' }]);
    expect(() => rememberProviderKey('META_API_KEY', '', { platform: 'darwin', run })).toThrow('empty');
    const failing = runnerFor([{ code: 1, stdout: 'denied' }]);
    expect(() => rememberProviderKey('META_API_KEY', 'sk-secret', { platform: 'darwin', run: failing.run }))
      .toThrow('refused');
    expect(() => rememberProviderKey('META_API_KEY', 'sk-secret', { platform: 'win32', run })).toThrow('unavailable');
    try {
      rememberProviderKey('META_API_KEY', 'sk-secret', { platform: 'darwin', run: failing.run });
    } catch (err) {
      expect(String(err)).not.toContain('sk-secret');
    }
  });
});

describe('forgetProviderKey', () => {
  it('distinguishes deleted, missing, and refused on macOS', () => {
    const deleted = runnerFor([{ code: 0, stdout: '' }]);
    expect(forgetProviderKey('META_API_KEY', { platform: 'darwin', run: deleted.run, available: true }))
      .toBe('deleted');
    expect(deleted.calls[0].exe).toBe('security');
    expect(deleted.calls[0].args[0]).toBe('delete-generic-password');
    const missing = runnerFor([{ code: 44, stdout: '' }]);
    expect(forgetProviderKey('META_API_KEY', { platform: 'darwin', run: missing.run, available: true }))
      .toBe('missing');
    const refused = runnerFor([{ code: 1, stdout: '' }]);
    expect(() => forgetProviderKey('META_API_KEY', { platform: 'darwin', run: refused.run, available: true }))
      .toThrow('refused the deletion');
  });

  it('checks before clearing on Linux', () => {
    const absent = runnerFor([{ code: 1, stdout: '' }]);
    expect(forgetProviderKey('META_API_KEY', { platform: 'linux', run: absent.run, available: true }))
      .toBe('missing');
    expect(absent.calls).toHaveLength(1);
    const present = runnerFor([{ code: 0, stdout: 'sk-secret\n' }, { code: 0, stdout: '' }]);
    expect(forgetProviderKey('META_API_KEY', { platform: 'linux', run: present.run, available: true }))
      .toBe('deleted');
    expect(present.calls).toHaveLength(2);
    const refused = runnerFor([{ code: 0, stdout: 'sk-secret\n' }, { code: 1, stdout: '' }]);
    expect(() => forgetProviderKey('META_API_KEY', { platform: 'linux', run: refused.run, available: true }))
      .toThrow('refused the deletion');
    const hung: KeychainRunner = () => ({ code: null, stdout: '', timedOut: true });
    expect(() => forgetProviderKey('META_API_KEY', { platform: 'linux', run: hung, available: true }))
      .toThrow('refused the deletion');
  });

  it('is a silent no-op where no backend exists', () => {
    const { run, calls } = runnerFor([{ code: 0, stdout: '' }]);
    expect(forgetProviderKey('META_API_KEY', { platform: 'win32', run })).toBe('missing');
    expect(calls).toHaveLength(0);
  });
});
