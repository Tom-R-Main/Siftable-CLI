import {describe, expect, it} from 'vitest';
import {
  buildSystemdCredentialDecryptArguments,
  buildSystemdCredentialEncryptArguments,
  systemdCredentialName,
} from './systemdKeyringIdentityStore.js';

describe('systemd-managed endpoint identity store', () => {
  const account = 'a'.repeat(64);

  it('uses host-bound systemd encryption with secret bytes on stdin', () => {
    const args = buildSystemdCredentialEncryptArguments(account, '/private/output.cred');
    expect(args).toEqual([
      'encrypt', `--name=sift-vault-${account}`, '--with-key=host', '-', '/private/output.cred',
    ]);
  });

  it('decrypts to stdout without placing key material in arguments', () => {
    expect(buildSystemdCredentialDecryptArguments(account, '/private/input.cred')).toEqual([
      'decrypt', `--name=sift-vault-${account}`, '/private/input.cred', '-',
    ]);
  });

  it('rejects unsafe credential names', () => {
    expect(() => systemdCredentialName('../unsafe')).toThrow('invalid');
  });
});
