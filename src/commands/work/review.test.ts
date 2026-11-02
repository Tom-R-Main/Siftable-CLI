import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import WorkReview from './review.js';
import type {GitReader} from '../../lib/work-coverage/bind.js';

vi.mock('../../lib/work-lease-session.js', () => ({
  readWorkLeaseSession: vi.fn(async () => null),
  lookupWorkLeaseSession: vi.fn(async () => ({state: 'missing'})),
  deleteWorkLeaseSession: vi.fn(async () => undefined),
  writeWorkLeaseSession: vi.fn(async () => undefined),
}));

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const TEST_FILE = 'exf-app/src/routes/modelConnections.test.ts';
const REVIEWED = {workItem: {id: 'work-1', status: 'needs_review', claimToken: 'secret-token'}};
const EXPECTED_RESULT = {workItem: {id: 'work-1', status: 'needs_review'}};
const PLAN = {
  activePlanVersion: 2,
  plan: {version: 2, steps: [{id: 's1', key: 'unit', kind: 'shell', title: 'unit',
    spec: {command: 'npm exec -- nx run @execufunction/exf-app:test:unit -- modelConnections'}}]},
};
const SHADOW = {status: 'recorded', recordId: '22222222-2222-4222-8222-222222222222', criteria: 1, requests: 2};

function reader(): GitReader {
  return {
    resolveCommit: vi.fn(async () => COMMIT),
    listFiles: vi.fn(async () => [TEST_FILE]),
    show: vi.fn(async () => "it('never echoes', () => { expect(body).not.toContain(SECRET); });\n"),
  };
}

function prepare(apiRequest = vi.fn(async (_flags: unknown, path: string) => (path.endsWith('/verification-plan') ? PLAN : SHADOW))) {
  const command = Object.create(WorkReview.prototype) as {run(): Promise<unknown>} & Record<string, any>;
  const transitionWorkItem = vi.fn(async () => ({statusCode: 200, data: REVIEWED}));
  command.parse = vi.fn().mockResolvedValue({args: {id: 'work-1'}, flags: {'api-url': 'https://api.test', summary: 'ready'}});
  command.client = vi.fn(async () => ({transitionWorkItem}));
  command.apiRequest = apiRequest;
  command.coverageShadowGitReader = () => reader();
  command.jsonEnabled = () => true;
  command.log = vi.fn();
  return {command, transitionWorkItem, apiRequest};
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sift work review coverage shadow', () => {
  it('makes no extra API call when SIFT_COVERAGE_SHADOW is unset', async () => {
    vi.stubEnv('SIFT_COVERAGE_SHADOW', '');
    const {command, transitionWorkItem, apiRequest} = prepare();
    const result = await command.run();
    expect(transitionWorkItem).toHaveBeenCalledWith('work-1', 'review', expect.anything(), expect.anything());
    expect(apiRequest).not.toHaveBeenCalled();
    expect(result).toEqual(EXPECTED_RESULT);
  });

  it('posts the coverage shadow after the review transition when enabled, and saves it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sift-coverage-shadow-'));
    try {
      vi.stubEnv('SIFT_COVERAGE_SHADOW', '1');
      vi.stubEnv('SIFT_COVERAGE_SHADOW_SAVE_DIR', dir);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const {command, transitionWorkItem, apiRequest} = prepare();
      const result = await command.run();

      expect(result).toEqual(EXPECTED_RESULT);
      expect(apiRequest.mock.calls.map(([, path]) => path)).toEqual([
        '/api/v1/work-items/work-1/verification-plan',
        '/api/v1/work-items/work-1/coverage-shadow',
      ]);
      expect(transitionWorkItem.mock.invocationCallOrder[0]).toBeLessThan(apiRequest.mock.invocationCallOrder[0]);
      const [, , post] = apiRequest.mock.calls[1] as unknown as [unknown, string, {method: string; body: {commit: string}}];
      expect(post.method).toBe('POST');
      expect(post.body.commit).toBe(COMMIT);
      expect(stderr).not.toHaveBeenCalled();

      const [saved] = await readdir(dir);
      expect(saved).toMatch(/^work-1-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
      const file = JSON.parse(await readFile(join(dir, saved), 'utf8'));
      expect(file.workItemId).toBe('work-1');
      expect(Number.isNaN(Date.parse(file.savedAt))).toBe(false);
      expect(file.payload).toEqual(post.body);
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  it('keeps the review result and exit code when the shadow fails, with one stderr warning', async () => {
    vi.stubEnv('SIFT_COVERAGE_SHADOW', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitCode = process.exitCode;
    const {command, apiRequest} = prepare(vi.fn(async () => {
      throw new Error('API error (500):\nboom');
    }));
    const result = await command.run();

    expect(result).toEqual(EXPECTED_RESULT);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(exitCode);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith('Warning: coverage shadow did not run: API error (500): boom\n');
    expect(command.log).not.toHaveBeenCalled();
  });

  it('cancels a stalled shadow after SIFT_COVERAGE_SHADOW_TIMEOUT_MS and still returns the review result', async () => {
    vi.stubEnv('SIFT_COVERAGE_SHADOW', '1');
    vi.stubEnv('SIFT_COVERAGE_SHADOW_TIMEOUT_MS', '50');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const hanging = vi.fn((_flags: unknown, _path: string, options?: {signal?: AbortSignal}) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason));
    }));
    const {command} = prepare(hanging as never);
    const result = await command.run();

    expect(result).toEqual(EXPECTED_RESULT);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect((hanging.mock.calls[0][2] as {signal: AbortSignal}).signal.aborted).toBe(true);
    expect(stderr).toHaveBeenCalledWith('Warning: coverage shadow did not run: timed out after 50 ms\n');
  });
});

