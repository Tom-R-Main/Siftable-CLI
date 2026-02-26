import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('vault commands', () => {
  describe('vault list', () => {
    it('lists vault entries', async () => {
      mockFetch()
        .on('GET', '/api/v1/vault/entries')
        .reply(200, {entries: [fixtures.vaultEntry(), fixtures.vaultEntry({id: 'vault-002', name: 'DB Password'})]})
        .install();

      const result = await runCommand(['vault', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test Secret');
      expect(result.stdout).toContain('DB Password');
    });
  });

  describe('vault create', () => {
    it('creates a vault entry', async () => {
      mockFetch()
        .on('POST', '/api/v1/vault/entries')
        .reply(201, {entry: fixtures.vaultEntry({id: 'vault-new', name: 'New Secret'})})
        .install();

      const result = await runCommand([
        'vault', 'create',
        '--name', 'New Secret',
        '--payload', '{"key":"value"}',
        '--token', 'exf_pat_test',
      ]);
      expect(result.stdout).toContain('Vault entry created');
    });
  });

  describe('vault search', () => {
    it('searches vault entries', async () => {
      mockFetch()
        .on('GET', '/api/v1/vault/entries')
        .reply(200, {entries: [fixtures.vaultEntry()]})
        .install();

      const result = await runCommand(['vault', 'search', 'test', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test Secret');
    });
  });
});
