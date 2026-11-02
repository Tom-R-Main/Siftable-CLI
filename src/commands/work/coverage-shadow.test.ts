import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import WorkCoverageShadow from './coverage-shadow.js';
import type {GitReader} from '../../lib/work-coverage/bind.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TEST_FILE = 'exf-app/src/routes/modelConnections.test.ts';
const SRC = "describe('routes', () => {\n  it('never echoes', () => { expect(body).not.toContain(SECRET); });\n});\n";

const PLAN = {
  activePlanVersion: 3,
  plan: {
    version: 3,
    steps: [
      {id: 's1', key: 'unit', kind: 'shell', title: 'unit', spec: {command: 'npm exec -- nx run @execufunction/exf-app:test:unit -- modelConnections'}},
      {id: 's2', key: 'web', kind: 'shell', title: 'web', spec: {command: 'npm exec -- nx run @execufunction/web:test'}},
    ],
  },
};

function git(resolved: string | null = COMMIT): GitReader {
  return {
    resolveCommit: vi.fn(async () => resolved),
    listFiles: vi.fn(async () => [TEST_FILE, 'README.md']),
    show: vi.fn(async (_c: string, path: string) => (path === TEST_FILE ? SRC : '')),
  };
}

function prepare(flags: Record<string, unknown>, reader: GitReader, postResponse: unknown = {}) {
  const command = Object.create(WorkCoverageShadow.prototype) as {run(): Promise<unknown>} & Record<string, any>;
  command.parse = vi.fn().mockResolvedValue({args: {id: 'work-1'}, flags});
  command.apiRequest = vi.fn(async (_flags: unknown, path: string) => (path.endsWith('/verification-plan') ? PLAN : postResponse));
  command.gitReader = () => reader;
  command.jsonEnabled = () => true;
  command.log = vi.fn();
  command.error = vi.fn((message: string) => {
    throw new Error(message);
  });
  return command;
}

describe('sift work coverage-shadow', () => {
  it('prints the candidate summary on --dry-run and never posts', async () => {
    const reader = git();
    const command = prepare({'dry-run': true}, reader);
    const result = await command.run() as Record<string, unknown>;

    expect(command.apiRequest).toHaveBeenCalledTimes(1);
    expect(command.apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/work-items/work-1/verification-plan');
    expect(reader.resolveCommit).toHaveBeenCalledWith('HEAD');
    expect(reader.listFiles).toHaveBeenCalledWith(COMMIT);
    expect(result).toMatchObject({
      status: 'dry_run', posted: false, workItemId: 'work-1', commit: COMMIT, planVersion: 3,
      candidates: 1, skippedCases: 0, files: [TEST_FILE], candidatesComplete: false,
      incompleteReasons: ['whole_target: npm exec -- nx run @execufunction/web:test'],
    });
    expect(result.payloadBytes).toBeGreaterThan(100);
  });

  it('writes the built payload with --save, with or without --dry-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sift-coverage-save-'));
    try {
      const dryPath = join(dir, 'nested', 'dry.json');
      const dry = prepare({'dry-run': true, save: dryPath}, git());
      const dryResult = await dry.run() as Record<string, unknown>;
      expect(dry.apiRequest).toHaveBeenCalledTimes(1);
      expect(dryResult.savedTo).toBe(dryPath);
      const saved = JSON.parse(await readFile(dryPath, 'utf8'));
      expect(Object.keys(saved)).toEqual(['workItemId', 'savedAt', 'payload']);
      expect(saved.workItemId).toBe('work-1');
      expect(new Date(saved.savedAt).toISOString()).toBe(saved.savedAt);
      expect(saved.payload).toMatchObject({schemaVersion: 1, commit: COMMIT, planVersion: 3});
      expect(saved.payload.candidates).toHaveLength(1);

      const postPath = join(dir, 'post.json');
      const post = prepare({save: postPath}, git(), {status: 'recorded', recordId: null, criteria: 1, requests: 2});
      await post.run();
      const [, , options] = post.apiRequest.mock.calls[1];
      expect(JSON.parse(await readFile(postPath, 'utf8')).payload).toEqual(options.body);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('prints a human summary on --dry-run', async () => {
    const command = prepare({'dry-run': true}, git());
    command.jsonEnabled = () => false;
    await command.run();
    const lines = command.log.mock.calls.map(([line]: [string]) => line);
    expect(lines[0]).toBe(`Commit ${COMMIT}, plan v3`);
    expect(lines).toContain(`  ${TEST_FILE}`);
    expect(lines).toContain('Candidate list incomplete:');
    expect(lines.at(-1)).toBe('dry run: nothing was posted');
  });

  it('posts the payload and returns the response status', async () => {
    const response = {status: 'recorded', recordId: '11111111-1111-4111-8111-111111111111', criteria: 2, requests: 4};
    const reader = git();
    const command = prepare({commit: COMMIT}, reader, response);
    const result = await command.run() as Record<string, unknown>;

    expect(reader.resolveCommit).toHaveBeenCalledWith(COMMIT);
    expect(command.apiRequest).toHaveBeenCalledTimes(2);
    const [, path, options] = command.apiRequest.mock.calls[1];
    expect(path).toBe('/api/v1/work-items/work-1/coverage-shadow');
    expect(options.method).toBe('POST');
    expect(options.body).toMatchObject({
      schemaVersion: 1, commit: COMMIT, planVersion: 3, candidatesComplete: false,
      candidates: [{file: TEST_FILE, line: 2, describePath: ['routes'], title: 'never echoes',
        assertions: ['expect(body).not.toContain(SECRET)']}],
    });
    expect(result).toMatchObject({...response, posted: true, summary: {candidates: 1}});
  });

  it('prints the response status in human mode', async () => {
    const command = prepare({}, git(), {status: 'disabled', recordId: null, criteria: 0, requests: 0});
    command.jsonEnabled = () => false;
    await command.run();
    expect(command.log).toHaveBeenCalledWith('Coverage shadow: disabled');
  });

  it('reports too_broad without posting', async () => {
    const many = Array.from({length: 151}, (_, i) => `it('c${i}', () => { expect(${i}).toBe(${i}); });`).join('\n');
    const reader = git();
    reader.show = vi.fn(async () => many);
    const command = prepare({}, reader);
    const result = await command.run() as Record<string, unknown>;
    expect(command.apiRequest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({status: 'too_broad', posted: false, candidates: 151});
  });

  it('rejects a commit that does not resolve to 40 hex', async () => {
    const command = prepare({commit: 'nope'}, git(null));
    await expect(command.run()).rejects.toThrow('Cannot resolve nope to a 40-hex commit in this checkout.');
    expect(command.apiRequest).not.toHaveBeenCalled();
  });
});
