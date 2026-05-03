import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('projects commands', () => {
  describe('projects list', () => {
    it('lists projects in table format', async () => {
      mockFetch()
        .on('GET', '/api/v1/projects')
        .reply(200, {projects: [fixtures.project()]})
        .install();

      const result = await runCommand(['projects', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test project');
    });

    it('returns JSON array', async () => {
      mockFetch()
        .on('GET', '/api/v1/projects')
        .reply(200, {projects: [fixtures.project()]})
        .install();

      const result = await runCommand(['projects', 'list', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json[0].name).toBe('Test project');
    });
  });

  describe('projects create', () => {
    it('creates a project', async () => {
      mockFetch()
        .on('POST', '/api/v1/projects')
        .reply(201, {project: fixtures.project({id: 'proj-new'})})
        .install();

      const result = await runCommand(['projects', 'create', '--name', 'New project', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Project created');
    });
  });

  describe('projects context', () => {
    it('shows project context', async () => {
      mockFetch()
        .on('GET', '/api/v1/projects/proj-001/context')
        .reply(200, {
          project: fixtures.project(),
          tasks: [fixtures.task()],
          notes: [fixtures.note()],
        })
        .install();

      const result = await runCommand(['projects', 'context', 'proj-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test project');
    });

    it('returns JSON context', async () => {
      const ctx = {
        project: fixtures.project(),
        tasks: [fixtures.task()],
        notes: [],
      };
      mockFetch()
        .on('GET', '/api/v1/projects/proj-001/context')
        .reply(200, ctx)
        .install();

      const result = await runCommand(['projects', 'context', 'proj-001', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.project.name).toBe('Test project');
    });
  });

  describe('projects planning', () => {
    it('shows the canonical planning snapshot', async () => {
      mockFetch()
        .on('GET', '/api/v1/projects/proj-001/planning')
        .reply(200, {
          state: {lastComputeStatus: 'success', dirty: false, lastComputedAt: '2026-01-01T00:00:00Z'},
          snapshot: {
            mcPercentiles: {p50: 3, p80: 5, p95: 8},
            invalidCycles: [],
            priorityRanking: [{taskId: 'task-001', priority: 0.9, reason: 'Highest leverage'}],
            criticalCorridor: [{taskId: 'task-001', criticality: 0.8}],
          },
          tasks: [fixtures.task()],
        })
        .install();

      const result = await runCommand(['projects', 'planning', 'proj-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Highest leverage');
      expect(result.stdout).toContain('Critical corridor');
    });
  });

  describe('projects archive', () => {
    it('archives with --yes', async () => {
      mockFetch()
        .on('POST', '/api/v1/projects/proj-001/archive')
        .reply(200, {project: fixtures.project({status: 'archived'})})
        .install();

      const result = await runCommand(['projects', 'archive', 'proj-001', '--token', 'exf_pat_test', '--yes']);
      expect(result.stdout).toContain('archived');
    });
  });
});
