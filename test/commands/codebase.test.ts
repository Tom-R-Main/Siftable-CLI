import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('codebase commands', () => {
  describe('codebase topic help', () => {
    it('does not treat bare codebase as a missing-id indexing invocation', async () => {
      const result = await runCommand(['codebase']);
      expect(result.stdout).toContain('Code context');
      expect(result.stdout).toContain('Deprecated hosted full-ingestion path');
      expect(result.stdout).toContain('codebase incremental');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('codebase list', () => {
    it('lists repositories', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/repositories')
        .reply(200, {repositories: [fixtures.repository()]})
        .install();

      const result = await runCommand(['codebase', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('test-repo');
    });
  });

  describe('codebase register', () => {
    it('registers a repository', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/repositories')
        .reply(201, {repository: fixtures.repository({id: 'repo-new'})})
        .install();

      const result = await runCommand([
        'codebase', 'register',
        '--name', 'my-repo',
        '--path', '/tmp/repo',
        '--token', 'exf_pat_test',
      ]);
      expect(result.stdout).toContain('Repository registered');
    });

    it('surfaces machine-readable deprecation guidance', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/repositories')
        .reply(410, {
          type: 'codebase_ingestion_deprecated',
          title: 'Hosted codebase ingestion deprecated',
          status: 410,
          detail: 'Hosted codebase ingestion is deprecated and new source uploads are disabled.',
          code: 'CODEBASE_INGESTION_DEPRECATED',
          action: 'Use rg in an authorized live checkout.',
        })
        .install();

      const result = await runCommand([
        'codebase', 'register',
        '--name', 'my-repo',
        '--path', '/tmp/repo',
        '--token', 'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('CODEBASE_INGESTION_DEPRECATED');
      expect(result.error?.message).toContain('Use rg');
    });
  });

  describe('codebase index', () => {
    it('preflights the server capability before reading the local path', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/capabilities')
        .reply(200, {
          capabilities: {
            hostedIngestion: {
              enabled: false,
              state: 'deprecated',
              code: 'CODEBASE_INGESTION_DEPRECATED',
              message: 'Hosted codebase ingestion is deprecated.',
              action: 'Use git grep in an authorized live checkout.',
            },
          },
        })
        .install();

      const result = await runCommand([
        'codebase', 'index', 'repo-001',
        '--path', '/path/that/does/not/exist',
        '--token', 'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('CODEBASE_INGESTION_DEPRECATED');
      expect(result.error?.message).toContain('Use git grep');
    });
  });

  describe('codebase status', () => {
    it('shows repository status', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/repositories/repo-001')
        .reply(200, {repository: fixtures.repository()})
        .install();

      const result = await runCommand(['codebase', 'status', 'repo-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('test-repo');
      expect(result.stdout).toContain('indexed');
    });
  });

  describe('codebase search', () => {
    it('searches code', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/repositories')
        .reply(200, {repositories: []})
        .on('POST', '/api/v1/code/search')
        .reply(200, {results: [{filePath: 'src/index.ts', symbolName: 'main', symbolType: 'function', score: 0.9}]})
        .install();

      const result = await runCommand(['codebase', 'search', 'main function', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('src/index.ts');
      expect(result.stdout).toContain('main');
    });

    it('passes explicit repo scope', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/search')
        .body((body) => (body as Record<string, unknown>).repositoryId === 'repo-123')
        .reply(200, {results: []})
        .install();

      const result = await runCommand(['codebase', 'search', 'rate limit', '--repo', 'repo-123', '--token', 'exf_pat_test']);
      expect(result.exitCode).toBe(0);
    });

    it('passes explicit project scope', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/search')
        .body((body) => (body as Record<string, unknown>).projectId === 'proj-123')
        .reply(200, {results: []})
        .install();

      const result = await runCommand(['codebase', 'search', 'rate limit', '--project', 'proj-123', '--token', 'exf_pat_test']);
      expect(result.exitCode).toBe(0);
    });

    it('auto-scopes to the registered repository for the current working directory', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/repositories')
        .reply(200, {repositories: [
          fixtures.repository({id: 'repo-parent', rootPath: '/tmp'}),
          fixtures.repository({id: 'repo-current', rootPath: process.cwd()}),
        ]})
        .on('POST', '/api/v1/code/search')
        .body((body) => (body as Record<string, unknown>).repositoryId === 'repo-current')
        .reply(200, {results: []})
        .install();

      const result = await runCommand(['codebase', 'search', 'rate limit', '--token', 'exf_pat_test']);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('codebase incremental help', () => {
    it('exposes incremental indexing as a direct command', async () => {
      const result = await runCommand(['codebase', 'incremental']);
      expect(result.exitCode).toBe(2);
      expect(result.error?.message).toContain('Missing 1 required arg');
      expect(result.error?.message).toContain('Repository ID');
    });

    it('preflights the server capability before inspecting git state', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/capabilities')
        .reply(200, {
          capabilities: {
            hostedIngestion: {
              enabled: false,
              state: 'deprecated',
              code: 'CODEBASE_INGESTION_DEPRECATED',
              message: 'Hosted codebase ingestion is deprecated.',
              action: 'Use rg in an authorized live checkout.',
            },
          },
        })
        .install();

      const result = await runCommand([
        'codebase', 'incremental', 'repo-001',
        '--path', '/path/that/does/not/exist',
        '--token', 'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('CODEBASE_INGESTION_DEPRECATED');
      expect(result.error?.message).toContain('Use rg');
    });
  });
});
