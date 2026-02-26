import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('code commands', () => {
  describe('code memory store', () => {
    it('stores a code memory', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/memories')
        .reply(201, {id: 'mem-new', fact: 'New fact', category: 'convention'})
        .install();

      const result = await runCommand([
        'code', 'memory', 'store',
        '--fact', 'New fact',
        '--category', 'convention',
        '--token', 'exf_pat_test',
      ]);
      expect(result.stdout).toContain('Fact stored');
    });
  });

  describe('code memory list', () => {
    it('lists code memories', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/memories')
        .reply(200, {memories: [fixtures.memory()]})
        .install();

      const result = await runCommand(['code', 'memory', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test fact');
    });
  });

  describe('code memory search', () => {
    it('searches code memories', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/memories/search')
        .reply(200, {memories: [fixtures.memory()]})
        .install();

      const result = await runCommand(['code', 'memory', 'search', 'test', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test fact');
    });
  });

  describe('code history', () => {
    it('shows commit history', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/repositories/repo-001/commits')
        .reply(200, {commits: [
          {sha: 'abc12345def', authorName: 'Test Author', message: 'Initial commit', authorDate: '2026-01-01T00:00:00Z'},
        ]})
        .install();

      const result = await runCommand(['code', 'history', 'repo-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('abc12345');
      expect(result.stdout).toContain('Test Author');
    });
  });
});
