import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';

installIsolatedConfigDirHooks('exf-cli-tasks-test-');

afterAll(() => {
  restoreFetch();
});

describe('tasks commands', () => {
  describe('tasks list', () => {
    it('lists tasks in table format', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks')
        .reply(200, {tasks: [fixtures.task(), fixtures.task({id: 'task-002', title: 'Second task'})]})
        .install();

      const result = await runCommand(['tasks', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test task');
      expect(result.stdout).toContain('Second task');
    });

    it('returns JSON array when --json is passed', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks')
        .reply(200, {tasks: [fixtures.task()]})
        .install();

      const result = await runCommand(['tasks', 'list', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json[0].id).toBe('task-001');
    });

    it('shows "No results" for empty list', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks')
        .reply(200, {tasks: []})
        .install();

      const result = await runCommand(['tasks', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('No results');
    });

    it('does not send legacy executor filters for human planning tasks', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks')
        .query((url) => !url.searchParams.has('executorAgent'))
        .reply(200, {tasks: [fixtures.task()]})
        .install();

      const result = await runCommand(['tasks', 'list', '--token', 'exf_pat_test', '--phase', 'open']);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toContain('Test task');
    });
  });

  describe('tasks get', () => {
    it('shows task details', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks/task-001')
        .reply(200, fixtures.task({executorAgent: 'codex'}))
        .install();

      const result = await runCommand(['tasks', 'get', 'task-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test task');
      expect(result.stdout).toContain('inbox');
      expect(result.stdout).toContain('Agent Work');
      expect(result.stdout).toContain('work list --task task-001');
      expect(result.stdout).not.toContain('Executor');
      expect(result.stdout).not.toContain('codex');
    });

    it('returns JSON for --json', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks/task-001')
        .reply(200, fixtures.task())
        .install();

      const result = await runCommand(['tasks', 'get', 'task-001', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.id).toBe('task-001');
      expect(json.title).toBe('Test task');
    });
  });

  describe('tasks create', () => {
    it('creates a task and shows confirmation', async () => {
      mockFetch()
        .on('POST', '/api/v1/tasks')
        .body((body) => (body as any).title === 'New task' && !('executorAgent' in (body as any)))
        .reply(201, {task: fixtures.task({id: 'task-new', title: 'New task'})})
        .install();

      const result = await runCommand(['tasks', 'create', '--title', 'New task', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Planning task created: task-new');
      expect(result.stdout).toContain('work create --task task-new');
    });

    it('returns created task as JSON', async () => {
      mockFetch()
        .on('POST', '/api/v1/tasks')
        .reply(201, {task: fixtures.task({id: 'task-new', title: 'New task'})})
        .install();

      const result = await runCommand(['tasks', 'create', '--title', 'New task', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.task.id).toBe('task-new');
    });

    it('returns structured JSON errors when the API rejects creation', async () => {
      mockFetch()
        .on('POST', '/api/v1/tasks')
        .reply(400, {
          type: 'bad_request',
          title: 'Focus queue full',
          status: 400,
          detail: 'You already have 3 tasks in Now. Move something to Today or Soon first.',
          instance: '/api/v1/tasks',
        })
        .install();

      const result = await runCommand([
        'tasks',
        'create',
        '--title',
        'New task',
        '--priority',
        'do_now',
        '--token',
        'exf_pat_test',
        '--json',
      ]);

      const json = JSON.parse(result.stdout);
      expect(json.error.message).toBe(
        'Focus queue full: You already have 3 tasks in Now. Move something to Today or Soon first.'
      );
      expect(json.error.code).toBe('bad_request');
      expect(json.error.exit).toBe(400);
      expect(json.error.statusCode).toBe(400);
      expect(json.error.api.title).toBe('Focus queue full');
    });
  });

  describe('tasks complete', () => {
    it('marks task as complete via PATCH', async () => {
      mockFetch()
        .on('PATCH', '/api/v1/tasks/task-001')
        .reply(200, {task: fixtures.task({status: 'completed'})})
        .install();

      const result = await runCommand(['tasks', 'complete', 'task-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('completed');
    });
  });

  describe('tasks planning and coupling', () => {
    it('updates task planning fields', async () => {
      mockFetch()
        .on('PATCH', '/api/v1/tasks/task-001/planning')
        .reply(200, {
          planning: {
            cynefinDomain: 'complicated',
            cynefinConfidence: 0.8,
            reversibility: 0.5,
            criticalityIndex: 0.7,
          },
        })
        .install();

      const result = await runCommand([
        'tasks',
        'planning-update',
        'task-001',
        '--cynefin-domain',
        'complicated',
        '--cynefin-confidence',
        '0.8',
        '--token',
        'exf_pat_test',
      ]);

      expect(result.stdout).toContain('complicated');
      expect(result.stdout).toContain('0.7');
    });

    it('lists task coupling edges', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks/task-001/coupling-edges')
        .reply(200, {
          edges: [{
            id: 'edge-001',
            sourceTaskId: 'task-001',
            targetTaskId: 'task-002',
            couplingType: 'info',
            strength: 0.75,
          }],
        })
        .install();

      const result = await runCommand(['tasks', 'coupling-list', 'task-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('edge-001');
      expect(result.stdout).toContain('task-002');
    });
  });

  describe('tasks delete', () => {
    it('deletes task with --yes flag', async () => {
      mockFetch()
        .on('DELETE', '/api/v1/tasks/task-001')
        .reply(200, {deleted: true})
        .install();

      const result = await runCommand(['tasks', 'delete', 'task-001', '--token', 'exf_pat_test', '--yes']);
      expect(result.stdout).toContain('deleted');
    });

    it('requires --yes in non-interactive mode', async () => {
      const result = await runCommand(['tasks', 'delete', 'task-001', '--token', 'exf_pat_test', '--no-input']);
      expect(result.error).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('handles 401 with auth suggestion', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks')
        .reply(401, {error: 'Invalid token'})
        .install();

      const result = await runCommand(['tasks', 'list', '--token', 'exf_pat_bad']);
      expect(result.error?.message).toContain('Authentication failed');
    });

    it('handles 404', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks/nonexistent')
        .reply(404, {error: 'Task not found'})
        .install();

      const result = await runCommand(['tasks', 'get', 'nonexistent', '--token', 'exf_pat_test']);
      expect(result.error?.message).toContain('Not found');
    });

    it('errors when no token available', async () => {
      const result = await runCommand(['tasks', 'list']);
      expect(result.error?.message).toContain('No authentication token');
    });
  });
});
