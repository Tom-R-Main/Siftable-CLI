import {mkdtempSync, writeFileSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'exf-cli-test-'));
});

afterAll(() => {
  restoreFetch();
  rmSync(tmpDir, {recursive: true, force: true});
});

describe('documents commands', () => {
  describe('documents upload', () => {
    it('uploads a markdown file', async () => {
      const filePath = join(tmpDir, 'test.md');
      writeFileSync(filePath, '# Test Document\n\nHello world');

      mockFetch()
        .on('POST', '/api/v1/notes')
        .reply(201, {note: fixtures.note({id: 'note-uploaded', title: 'test'})})
        .install();

      const result = await runCommand(['documents', 'upload', filePath, '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Document uploaded');
    });

    it('returns JSON when --json is passed', async () => {
      const filePath = join(tmpDir, 'test2.md');
      writeFileSync(filePath, '# Another doc');

      mockFetch()
        .on('POST', '/api/v1/notes')
        .reply(201, {note: fixtures.note({id: 'note-json', title: 'test2'})})
        .install();

      const result = await runCommand(['documents', 'upload', filePath, '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.note.id).toBe('note-json');
    });
  });
});
