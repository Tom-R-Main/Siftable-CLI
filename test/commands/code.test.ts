import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('code commands', () => {
  describe('codebase search compatibility', () => {
    it('returns typed local-search recovery without requiring a legacy query', async () => {
      const result = await runCommand([
        'codebase', 'search', '--json', '--no-input',
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'removed_capability',
        api: expect.objectContaining({
          type: 'removed_capability',
          capability: 'codebase_search',
        }),
        exit: 2,
      });
    });

    it('returns typed local-search recovery instead of a missing-command error', async () => {
      const result = await runCommand([
        'codebase', 'search', 'migration order V273b', '--json', '--no-input',
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'removed_capability',
        api: expect.objectContaining({
          type: 'removed_capability',
          capability: 'codebase_search',
        }),
        exit: 2,
      });
      expect(result.stdout).toContain('Use local `rg` or `git grep`');
    });
  });

  describe('code memory store', () => {
    it('stores a code memory', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/memories')
        .body((body) => {
          const input = body as Record<string, unknown>;
          return Array.isArray(input.evidenceChunkIds)
            && input.evidenceChunkIds[0] === '11111111-1111-4111-8111-111111111111';
        })
        .reply(201, {
          id: 'mem-new',
          content: 'New fact',
          factType: 'code.convention',
          evidence: {
            chunkIds: ['11111111-1111-4111-8111-111111111111'],
            availability: 'available',
            availableChunkCount: 1,
            missingChunkCount: 0,
          },
        })
        .install();

      const result = await runCommand([
        'code', 'memory', 'store',
        '--fact', 'New fact',
        '--category', 'convention',
        '--evidence-chunk', '11111111-1111-4111-8111-111111111111',
        '--token', 'exf_pat_test',
      ]);
      expect(result.stdout).toContain('Fact stored');
    });
  });

  describe('code memory list', () => {
    it('lists code memories', async () => {
      mockFetch()
        .on('GET', '/api/v1/code/memories')
        .reply(200, {
          memories: [fixtures.memory({
            repositoryName: 'retired-repo',
            evidence: {
              chunkIds: ['missing-chunk'],
              availability: 'missing',
              availableChunkCount: 0,
              missingChunkCount: 1,
            },
          })],
        })
        .install();

      const result = await runCommand(['code', 'memory', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test fact');
      expect(result.stdout).toContain('retired-repo');
      expect(result.stdout).toContain('missing');
    });
  });

  describe('code memory search', () => {
    it('searches code memories', async () => {
      mockFetch()
        .on('POST', '/api/v1/code/memories/search')
        .reply(200, {
          memories: [fixtures.memory({
            repositoryName: 'active-repo',
            evidence: {
              chunkIds: [],
              availability: 'not_recorded',
              availableChunkCount: 0,
              missingChunkCount: 0,
            },
          })],
        })
        .install();

      const result = await runCommand(['code', 'memory', 'search', 'test', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test fact');
      expect(result.stdout).toContain('active-repo');
      expect(result.stdout).toContain('not_recorded');
    });
  });
});
