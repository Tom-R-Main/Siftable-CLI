import {createHash} from 'node:crypto';
import {mkdtemp, readdir, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import WorkBlock from '../commands/work/block.js';
import WorkCancel from '../commands/work/cancel.js';
import WorkClaim from '../commands/work/claim.js';
import WorkComplete from '../commands/work/complete.js';
import WorkHeartbeat from '../commands/work/heartbeat.js';
import WorkRelease from '../commands/work/release.js';
import {readWorkLeaseSession, writeWorkLeaseSession, type WorkLeaseSession} from './work-lease-session.js';

// Every session in this suite lives under a fresh SIFT_CONFIG_DIR in the OS temp directory.
const API_URL = 'https://api.test';
const WORK_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_WORK_ID = '44444444-4444-4444-8444-444444444444';
const OWNER = 'codex:session-test';
const STORED_TOKEN = 'synthetic-stored-claim-token-never-render';
const EXPLICIT_TOKEN = 'synthetic-explicit-claim-token-never-render';
const FUTURE = '2099-01-01T00:00:00.000Z';
const STALE = '2020-01-01T00:00:00.000Z';
const MEMORY = '{"decision":"skip","rationale":"fixture"}';

type CommandClass = typeof WorkClaim | typeof WorkComplete | typeof WorkBlock | typeof WorkCancel | typeof WorkHeartbeat | typeof WorkRelease;
type Prepared = {
  command: {run(): Promise<unknown>} & Record<string, any>;
  transitionWorkItem: ReturnType<typeof vi.fn>;
  claimWorkItem: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
};

let configDir = '';
let output: string[] = [];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'sift-cli-work-action-session-'));
  vi.stubEnv('SIFT_CONFIG_DIR', configDir);
  output = [];
  const capture = (chunk: unknown) => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(configDir, {recursive: true, force: true});
});

function prepare(
  CommandClass: CommandClass,
  args: Record<string, unknown>,
  flags: Record<string, unknown>,
  transitionStatus = 'done',
  responseToken: string | null = STORED_TOKEN,
): Prepared {
  const command = Object.create(CommandClass.prototype) as Prepared['command'];
  const transitionWorkItem = vi.fn(async (id: string) => ({
    statusCode: 200,
    data: {workItem: {id, status: transitionStatus, claimToken: responseToken}},
  }));
  const claimWorkItem = vi.fn(async () => ({
    statusCode: 200,
    data: {workItem: {id: WORK_ID, status: 'claimed', claimOwner: OWNER, claimToken: STORED_TOKEN, claimExpiresAt: FUTURE}},
  }));
  const log = vi.fn((...parts: unknown[]) => output.push(parts.map(String).join(' ')));
  command.parse = vi.fn().mockResolvedValue({args, flags: {'api-url': API_URL, ...flags}});
  command.client = vi.fn(async () => ({transitionWorkItem, claimWorkItem}));
  command.jsonEnabled = () => true;
  command.log = log;
  return {command, transitionWorkItem, claimWorkItem, log};
}

function session(overrides: Partial<WorkLeaseSession> = {}): WorkLeaseSession {
  return {
    version: 1,
    workItemId: WORK_ID,
    claimOwner: OWNER,
    claimToken: STORED_TOKEN,
    expiresAt: FUTURE,
    apiUrl: API_URL,
    workspaceId: null,
    state: 'active',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

async function runAndCapture(prepared: Prepared): Promise<{result?: unknown; error?: Error; rendered: string}> {
  let result: unknown;
  let error: Error | undefined;
  try {
    result = await prepared.command.run();
  } catch (caught) {
    error = caught as Error;
  }
  const rendered = [
    ...output,
    JSON.stringify(result ?? null),
    error?.message ?? '',
    error?.stack ?? '',
  ].join('\n');
  return {result, error, rendered};
}

function expectNoToken(rendered: string): void {
  expect(rendered).not.toContain(STORED_TOKEN);
  expect(rendered).not.toContain(EXPLICIT_TOKEN);
}

describe('lease-owned work actions resolve the claim token from the saved lease session', () => {
  it('completes after claim without --claim-token or --owner and sends the stored token', async () => {
    const claim = await runAndCapture(prepare(WorkClaim, {id: WORK_ID}, {owner: OWNER, lease: 1800}));
    expect(claim.error).toBeUndefined();
    expectNoToken(claim.rendered);

    const complete = prepare(WorkComplete, {id: WORK_ID}, {summary: 'done', 'memory-decision': MEMORY});
    const {result, error, rendered} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN, resultSummary: 'done'}),
      expect.anything(),
    );
    expect(result).toEqual({workItem: {id: WORK_ID, status: 'done'}});
    expectNoToken(rendered);
    await expect(readWorkLeaseSession(WORK_ID)).resolves.toBeNull();
  });

  it('accepts --owner alone when it matches the saved claim owner', async () => {
    await writeWorkLeaseSession(session());
    const block = prepare(WorkBlock, {id: WORK_ID}, {owner: OWNER, reason: 'waiting'}, 'blocked');
    const {error, rendered} = await runAndCapture(block);

    expect(error).toBeUndefined();
    expect(block.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'block',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN, blockedReason: 'waiting'}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('cancels active work from the saved session', async () => {
    await writeWorkLeaseSession(session());
    const cancel = prepare(WorkCancel, {id: WORK_ID}, {}, 'cancelled');
    const {error, rendered} = await runAndCapture(cancel);

    expect(error).toBeUndefined();
    expect(cancel.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'cancel',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('lets an explicit --claim-token override the saved session', async () => {
    await writeWorkLeaseSession(session());
    const complete = prepare(WorkComplete, {id: WORK_ID}, {'claim-token': EXPLICIT_TOKEN, 'memory-decision': MEMORY});
    const {error, rendered} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({claimOwner: OWNER, claimToken: EXPLICIT_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('saves the explicit --claim-token when renewing the session', async () => {
    await writeWorkLeaseSession(session());
    const heartbeat = prepare(WorkHeartbeat, {id: WORK_ID}, {'claim-token': EXPLICIT_TOKEN}, 'running', null);
    const {error, rendered} = await runAndCapture(heartbeat);

    expect(error).toBeUndefined();
    expect(heartbeat.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'heartbeat',
      expect.objectContaining({claimOwner: OWNER, claimToken: EXPLICIT_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
    expect((await readWorkLeaseSession(WORK_ID))?.claimToken).toBe(EXPLICIT_TOKEN);
  });

  it('uses explicit --owner and --claim-token without reading the session', async () => {
    await writeWorkLeaseSession(session({apiUrl: 'https://other.test'}));
    const complete = prepare(WorkComplete, {id: WORK_ID}, {
      owner: 'codex:explicit',
      'claim-token': EXPLICIT_TOKEN,
      'memory-decision': MEMORY,
    });
    const {error} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({claimOwner: 'codex:explicit', claimToken: EXPLICIT_TOKEN}),
      expect.anything(),
    );
  });

  it('refuses a lease-owned action when no session exists', async () => {
    const block = prepare(WorkBlock, {id: WORK_ID}, {reason: 'waiting'});
    const {error, rendered} = await runAndCapture(block);

    expect(error?.message).toContain(`block needs the active claim, but no saved lease session was found for work item ${WORK_ID}`);
    expect(block.transitionWorkItem).not.toHaveBeenCalled();
    expectNoToken(rendered);
  });

  it('refuses complete with --owner alone when no session exists', async () => {
    const complete = prepare(WorkComplete, {id: WORK_ID}, {owner: OWNER, 'memory-decision': MEMORY});
    const {error, rendered} = await runAndCapture(complete);

    expect(error?.message).toContain('complete requires both --owner and --claim-token from the active claim');
    expect(error?.message).toContain('no saved lease session was found');
    expect(complete.transitionWorkItem).not.toHaveBeenCalled();
    expectNoToken(rendered);
  });

  it('sends the saved credentials past the cached deadline and lets the server decide', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE}));
    const block = prepare(WorkBlock, {id: WORK_ID}, {reason: 'waiting'}, 'blocked');
    const {error, rendered} = await runAndCapture(block);

    expect(error).toBeUndefined();
    expect(block.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'block',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN, blockedReason: 'waiting'}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('reports the server refusal of a lease that really expired without rendering the token', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE}));
    const heartbeat = prepare(WorkHeartbeat, {id: WORK_ID}, {});
    heartbeat.transitionWorkItem.mockResolvedValueOnce({
      statusCode: 409,
      error: JSON.stringify({error: 'The work item lease has expired'}),
    } as never);
    const {error, rendered} = await runAndCapture(heartbeat);

    expect(heartbeat.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'heartbeat',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN}),
      expect.anything(),
    );
    expect(error?.message).toContain('The work item lease has expired');
    expectNoToken(rendered);
  });

  it('completes with --owner alone past the cached deadline using the saved token', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE}));
    const complete = prepare(WorkComplete, {id: WORK_ID}, {owner: OWNER, 'memory-decision': MEMORY});
    const {error, rendered} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('releases a claim past the cached deadline with the saved credentials', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE}));
    const release = prepare(WorkRelease, {id: WORK_ID}, {}, 'queued');
    const {error, rendered} = await runAndCapture(release);

    expect(error).toBeUndefined();
    expect(release.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'release',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
    await expect(readWorkLeaseSession(WORK_ID)).resolves.toBeNull();
  });

  it('cancels blocked work in the saved scope past the cached deadline', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE, workspaceId: 'workspace-a'}));
    const cancel = prepare(WorkCancel, {id: WORK_ID}, {}, 'cancelled');
    const {error, rendered} = await runAndCapture(cancel);

    expect(error).toBeUndefined();
    expect(cancel.command.client).toHaveBeenCalledWith(expect.objectContaining({workspace: 'workspace-a'}));
    expect(cancel.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'cancel',
      expect.objectContaining({claimOwner: OWNER, claimToken: STORED_TOKEN}),
      expect.anything(),
    );
    expectNoToken(rendered);
    await expect(readWorkLeaseSession(WORK_ID)).resolves.toBeNull();
  });

  it('approves needs_review work past the cached deadline without a local memory-decision refusal', async () => {
    await writeWorkLeaseSession(session({expiresAt: STALE}));
    const complete = prepare(WorkComplete, {id: WORK_ID}, {summary: 'approved'});
    const {error, rendered} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({resultSummary: 'approved'}),
      expect.anything(),
    );
    expectNoToken(rendered);
  });

  it('still requires --memory-decision locally for complete under a current saved claim', async () => {
    await writeWorkLeaseSession(session());
    const complete = prepare(WorkComplete, {id: WORK_ID}, {summary: 'done'});
    const {error, rendered} = await runAndCapture(complete);

    expect(error?.message).toContain('complete under an active claim requires --memory-decision');
    expect(complete.transitionWorkItem).not.toHaveBeenCalled();
    expectNoToken(rendered);
  });

  it('refuses a session that records a different work item', async () => {
    // Write a valid session for another item, then place it at this item's session path.
    await writeWorkLeaseSession(session({workItemId: OTHER_WORK_ID}));
    const directory = join(configDir, 'work-sessions');
    const [file] = await readdir(directory);
    await rename(join(directory, file), join(directory, `${createHash('sha256').update(WORK_ID).digest('hex')}.json`));

    const complete = prepare(WorkComplete, {id: WORK_ID}, {'memory-decision': MEMORY});
    const {error, rendered} = await runAndCapture(complete);

    expect(error?.message).toContain(`The saved lease session found for work item ${WORK_ID} records a different work item`);
    expect(complete.transitionWorkItem).not.toHaveBeenCalled();
    expectNoToken(rendered);
  });

  it('refuses --owner that differs from the saved claim owner', async () => {
    await writeWorkLeaseSession(session());
    const complete = prepare(WorkComplete, {id: WORK_ID}, {owner: 'codex:someone-else', 'memory-decision': MEMORY});
    const {error, rendered} = await runAndCapture(complete);

    expect(error?.message).toContain('belongs to a different claim owner than --owner');
    expect(complete.transitionWorkItem).not.toHaveBeenCalled();
    expectNoToken(rendered);
  });

  it('still approves needs_review work without a claim or session', async () => {
    const complete = prepare(WorkComplete, {id: WORK_ID}, {summary: 'approved'});
    const {error} = await runAndCapture(complete);

    expect(error).toBeUndefined();
    expect(complete.transitionWorkItem).toHaveBeenCalledWith(
      WORK_ID,
      'complete',
      expect.objectContaining({claimOwner: undefined, claimToken: undefined}),
      expect.anything(),
    );
  });
});
