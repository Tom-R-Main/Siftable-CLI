import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

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
  });

  describe('tasks get', () => {
    it('shows task details', async () => {
      mockFetch()
        .on('GET', '/api/v1/tasks/task-001')
        .reply(200, fixtures.task())
        .install();

      const result = await runCommand(['tasks', 'get', 'task-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test task');
      expect(result.stdout).toContain('inbox');
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
        .reply(201, {task: fixtures.task({id: 'task-new', title: 'New task'})})
        .install();

      const result = await runCommand(['tasks', 'create', '--title', 'New task', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Task created');
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
      try { require('fs').unlinkSync(require('path').join(require('os').homedir(), '.config', 'exf', 'auth.json')); } catch {}

      const result = await runCommand(['tasks', 'list']);
      expect(result.error?.message).toContain('No authentication token');
    });
  });
});
