import {describe, expect, it} from 'vitest';
import {
  buildSecretServiceLookupArguments,
  buildSecretServiceStoreArguments,
} from './secretServiceKeyringIdentityStore.js';

describe('Secret Service convenience keyring', () => {
  const account = 'a'.repeat(64);

  it('passes only labels and selectors in process arguments', () => {
    const args = buildSecretServiceStoreArguments(account);
    expect(args).toEqual([
      'store', '--label=Siftable Vault materializer device identity',
      'service', 'io.siftable.cli.vault-materializer', 'account', account,
    ]);
  });

  it('uses the same exact selector for lookup', () => {
    expect(buildSecretServiceLookupArguments(account)).toEqual([
      'lookup', 'service', 'io.siftable.cli.vault-materializer', 'account', account,
    ]);
  });
});
