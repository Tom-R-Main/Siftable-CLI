import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('notes commands', () => {
  describe('notes list', () => {
    it('lists notes', async () => {
      mockFetch()
        .on('GET', '/api/v1/notes')
        .reply(200, {notes: [fixtures.note()]})
        .install();

      const result = await runCommand(['notes', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test note');
    });

    it('returns JSON', async () => {
      mockFetch()
        .on('GET', '/api/v1/notes')
        .reply(200, {notes: [fixtures.note()]})
        .install();

      const result = await runCommand(['notes', 'list', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json[0].title).toBe('Test note');
    });
  });

  describe('notes get', () => {
    it('shows note with content', async () => {
      mockFetch()
        .on('GET', '/api/v1/notes/note-001')
        .reply(200, fixtures.note())
        .install();

      const result = await runCommand(['notes', 'get', 'note-001', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test note');
      expect(result.stdout).toContain('Test content');
    });
  });

  describe('notes search', () => {
    it('searches notes', async () => {
      mockFetch()
        .on('GET', '/api/v1/notes/search')
        .reply(200, {results: [fixtures.note({score: 0.95})]})
        .install();

      const result = await runCommand(['notes', 'search', 'test', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test note');
    });
  });

  describe('notes create', () => {
    it('creates a note', async () => {
      mockFetch()
        .on('POST', '/api/v1/notes')
        .reply(201, {note: fixtures.note({id: 'note-new'})})
        .install();

      const result = await runCommand(['notes', 'create', '--title', 'New note', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Note created');
    });
  });

  describe('notes delete', () => {
    it('deletes with --yes', async () => {
      mockFetch()
        .on('DELETE', '/api/v1/notes/note-001')
        .reply(200, {deleted: true})
        .install();

      const result = await runCommand(['notes', 'delete', 'note-001', '--token', 'exf_pat_test', '--yes']);
      expect(result.stdout).toContain('deleted');
    });
  });
});
