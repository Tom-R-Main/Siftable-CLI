import {createPublicKey, verify} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {enrollMachine, MachineEnrollError, type MachineEnrollDeps} from './machineEnroll.js';
import {machineSupervisorProofBinding, type MachineEnrollmentRequest} from './machineProtocol.js';
import {acquireStateLock, inspectMachineState, type MachineStateOptions} from './machineState.js';
import {describeMachineState} from './machineStatus.js';
import {ensureSupervisorAccount, type Exec} from './systemAccount.js';

const API = 'https://api.example';
const ENROLLMENT_ID = '99999999-8888-4777-8666-555555555555';
const TOKEN = 'sift_pat_test_token_never_printed';

type Reply = {status: number; body?: unknown} | 'network-error';

/** A device-flow server that verifies every proof and replies to polls from a script. */
function fakeServer(polls: Reply[], extra: Record<string, Reply> = {}) {
  const calls: Array<{url: string; init: RequestInit}> = [];
  const requests: MachineEnrollmentRequest[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({url: target, init});
    expect(init.redirect).toBe('error');
    const reply = (value: Reply) => {
      if (value === 'network-error') throw new TypeError('fetch failed');
      return new Response(value.body === undefined ? '' : JSON.stringify(value.body), {status: value.status});
    };
    if (extra[target]) return reply(extra[target]);
    if (target === `${API}/auth/device/machine`) {
      const body = JSON.parse(String(init.body)) as MachineEnrollmentRequest;
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(body.publicKey, 'base64')]);
      const ok = verify(null, Buffer.from(machineSupervisorProofBinding(body, body.proof)),
        createPublicKey({key: spki, format: 'der', type: 'spki'}), Buffer.from(body.proof.signature, 'base64url'));
      expect(ok).toBe(true);
      requests.push(body);
      return reply({status: 200, body: {flow: 'machine_supervisor', device_code: `device-${requests.length}`,
        user_code: 'BCDF-GHJK', verification_uri_complete: `${API}/app/device?code=BCDF-GHJK`, expires_in: 900, interval: 5}});
    }
    if (target === `${API}/auth/device/token`) {
      const next = polls.shift();
      if (!next) throw new Error('unexpected poll');
      if (next !== 'network-error' && next.status === 200) {
        const request = requests[requests.length - 1];
        return reply({status: 200, body: {access_token: TOKEN, token_type: 'Bearer',
          machine: {enrollmentId: ENROLLMENT_ID, runnerId: request.runnerId, publicKeyFingerprint: request.fingerprint}}});
      }
      return reply(next);
    }
    throw new Error(`unexpected request ${target}`);
  }) as typeof fetch;
  return {fetchImpl, calls, requests};
}

describe('enrollMachine', () => {
  let root: string;
  let state: MachineStateOptions;
  let clock: number;
  let logged: string[];
  const deps = (fetchImpl: typeof fetch): MachineEnrollDeps => ({
    fetch: fetchImpl, state, now: () => new Date(clock),
    sleep: async (milliseconds) => { clock += milliseconds; },
    log: (line) => logged.push(line),
  });
  const options = {apiUrl: API, scope: {type: 'user' as const}, host: {os: 'linux', arch: 'x64'}, replace: false};

  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(tmpdir(), 'sift-machine-')), 'state');
    state = {root, owner: null};
    clock = Date.parse('2026-10-29T02:00:00Z');
    logged = [];
  });
  afterEach(async () => fs.rm(path.dirname(root), {recursive: true, force: true}));

  const mode = async (name: string) => ((await fs.stat(path.join(root, name))).mode & 0o777).toString(8);

  it('enrolls through one approval and keeps the credential 0600, out of every log line', async () => {
    const server = fakeServer([{status: 400, body: {error: 'authorization_pending'}}, {status: 200}]);
    const result = await enrollMachine(deps(server.fetchImpl), options);
    expect(result).toMatchObject({enrollmentId: ENROLLMENT_ID, runnerId: server.requests[0].runnerId, qualified: false});
    expect(await inspectMachineState(state)).toMatchObject({kind: 'enrolled', machine: {enrollmentId: ENROLLMENT_ID, apiUrl: API}});
    expect(await mode('.')).toBe('700');
    for (const name of ['enrollment-key.pem', 'credential.json', 'machine.json']) expect(await mode(name)).toBe('600');
    expect(JSON.parse(await fs.readFile(path.join(root, 'credential.json'), 'utf8'))).toEqual({token: TOKEN});
    expect(logged.join('\n')).not.toContain(TOKEN);
    await expect(fs.stat(path.join(root, 'pending.json'))).rejects.toMatchObject({code: 'ENOENT'});
    const status = await describeMachineState(root);
    expect(status.summary).toMatchObject({state: 'enrolled', enrollmentId: ENROLLMENT_ID, credentialPresent: true});
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    // Enrolling again without --replace is refused.
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/already enrolled/);
  });

  it('reuses the key and runner on a retry after the code expired, with a fresh proof', async () => {
    await expect(enrollMachine(deps(fakeServer([{status: 400, body: {error: 'expired_token'}}]).fetchImpl), options))
      .rejects.toThrow(/expired/);
    const pending = await inspectMachineState(state);
    expect(pending).toMatchObject({kind: 'pending', pending: {state: 'requesting'}});
    const server = fakeServer([{status: 200}]);
    await enrollMachine(deps(server.fetchImpl), options);
    const first = pending.kind === 'pending' ? pending.pending : undefined;
    expect(server.requests[0]).toMatchObject({runnerId: first?.runnerId, fingerprint: first?.fingerprint});
  });

  it('marks delivery unknown when a poll reply was lost and the code then reads expired', async () => {
    const server = fakeServer(['network-error', {status: 400, body: {error: 'expired_token'}}]);
    await expect(enrollMachine(deps(server.fetchImpl), options)).rejects.toThrow(/may have completed/);
    expect(await inspectMachineState(state)).toMatchObject({kind: 'pending', pending: {state: 'delivery_unknown'}});
    // It is never silently re-enrolled: --replace alone, or naming another runner, is refused.
    const lost = server.requests[0].runnerId;
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/may have completed/);
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), {...options, replace: true})).rejects.toThrow(`--abandon-runner ${lost}`);
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), {...options, replace: true, abandonRunner: 'other'}))
      .rejects.toThrow(/may have completed/);
    // Naming the runner the operator revoked starts over with a new key and runner.
    const fresh = fakeServer([{status: 200}]);
    await enrollMachine(deps(fresh.fetchImpl), {...options, replace: true, abandonRunner: lost});
    expect(fresh.requests[0].runnerId).not.toBe(server.requests[0].runnerId);
    expect((await fs.readdir(path.join(root, 'retired'))).length).toBe(1);
  });

  it('treats a run that was polling when it stopped as possibly delivered', async () => {
    // The first run is cut off after its poll was sent: the server consumed the token, and no reply came back.
    const crashed = fakeServer([]);
    const cutOff = ((url: string | URL, init?: RequestInit) => (String(url).endsWith('/token')
      ? Promise.reject(new Error('process killed')) : crashed.fetchImpl(url, init))) as typeof fetch;
    const killing = {...deps(cutOff), sleep: async (milliseconds: number) => {
      clock += milliseconds;
      if (clock > Date.parse('2026-10-29T02:00:20Z')) throw new Error('process killed');
    }};
    await expect(enrollMachine(killing, options)).rejects.toThrow(/process killed/);
    expect(await inspectMachineState(state)).toMatchObject({kind: 'pending', pending: {state: 'polling'}});
    // The rerun sees the code read as expired and refuses to treat that as a plain expiry.
    await expect(enrollMachine(deps(fakeServer([{status: 400, body: {error: 'expired_token'}}]).fetchImpl), options))
      .rejects.toThrow(/may have completed/);
    expect(await inspectMachineState(state)).toMatchObject({kind: 'pending', pending: {state: 'delivery_unknown'}});
  });

  it('lets only one enrollment run at a time', async () => {
    const slow = fakeServer([{status: 400, body: {error: 'authorization_pending'}}, {status: 200}]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = enrollMachine({...deps(slow.fetchImpl), sleep: async () => { await gate; }}, options);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/Another enrollment is running/);
    release();
    await expect(first).resolves.toMatchObject({enrollmentId: ENROLLMENT_ID});
    // A lock left by a process that is gone is reported, never taken over.
    await fs.writeFile(path.join(root, '.enroll.lock'), JSON.stringify({pid: 2 ** 22 + 12345, nonce: 'gone'}), {mode: 0o600});
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/stopped without releasing/);
    await fs.rm(path.join(root, '.enroll.lock'));
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/already enrolled/);
  });

  it('admits exactly one of many contenders for the lock, and releases only its own', async () => {
    await fs.mkdir(root, {recursive: true, mode: 0o700});
    const contenders = await Promise.allSettled(Array.from({length: 8}, () => acquireStateLock(state)));
    const winners = contenders.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const lock = path.join(root, '.enroll.lock');
    expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toMatchObject({pid: process.pid, nonce: expect.any(String)});
    // A lock that is no longer this holder's survives its release.
    await fs.writeFile(lock, JSON.stringify({pid: process.pid, nonce: 'someone-else'}));
    await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toMatchObject({nonce: 'someone-else'});
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('saves nothing when the approval names another machine', async () => {
    const server = fakeServer([]);
    const mismatched = fakeServer([], {[`${API}/auth/device/token`]: {status: 200, body: {access_token: TOKEN,
      machine: {enrollmentId: ENROLLMENT_ID, runnerId: '00000000-0000-4000-8000-000000000000', publicKeyFingerprint: 'a'.repeat(64)}}}});
    const fetchImpl = ((url: string | URL, init?: RequestInit) => (String(url).endsWith('/token')
      ? mismatched.fetchImpl(url, init) : server.fetchImpl(url, init))) as typeof fetch;
    await expect(enrollMachine(deps(fetchImpl), options)).rejects.toThrow(/does not match this machine/);
    await expect(fs.stat(path.join(root, 'credential.json'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('replaces an enrollment only after revoking it at its own API with its own credential', async () => {
    await enrollMachine(deps(fakeServer([{status: 200}]).fetchImpl), options);
    const revokeUrl = `${API}/api/v1/machines/enrollments/${ENROLLMENT_ID}/revoke`;
    const refused = fakeServer([], {[revokeUrl]: 'network-error'});
    await expect(enrollMachine(deps(refused.fetchImpl), {...options, replace: true})).rejects.toThrow(/did not get a reply/);
    expect(await inspectMachineState(state)).toMatchObject({kind: 'enrolled'});
    const server = fakeServer([{status: 200}], {[revokeUrl]: {status: 200, body: {enrollmentId: ENROLLMENT_ID}}});
    const result = await enrollMachine(deps(server.fetchImpl), {...options, replace: true});
    const revoke = server.calls.find((call) => call.url === revokeUrl);
    expect(revoke?.init.headers).toEqual({Authorization: `Bearer ${TOKEN}`});
    expect(result.replaced?.enrollmentId).toBe(ENROLLMENT_ID);
    const retired = await fs.readdir(path.join(root, 'retired'));
    expect(await fs.readdir(path.join(root, 'retired', retired[0]))).toEqual(
      expect.arrayContaining(['enrollment-key.pem', 'credential.json', 'machine.json']));
  });

  it('refuses partial or symlinked state', async () => {
    await fs.mkdir(root, {recursive: true, mode: 0o700});
    await fs.writeFile(path.join(root, 'credential.json'), '{}', {mode: 0o600});
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/partial enrollment/);
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), {...options, replace: true})).rejects.toThrow('--abandon-runner unknown');
    await fs.rm(path.join(root, 'credential.json'));
    await fs.symlink('/etc/passwd', path.join(root, 'machine.json'));
    await expect(enrollMachine(deps(fakeServer([]).fetchImpl), options)).rejects.toThrow(/symlink/);
  });

  it('is a MachineEnrollError when the API cannot be reached, and keeps the journal for a retry', async () => {
    const server = fakeServer([], {[`${API}/auth/device/machine`]: 'network-error'});
    await expect(enrollMachine(deps(server.fetchImpl), options)).rejects.toBeInstanceOf(MachineEnrollError);
    expect(await inspectMachineState(state)).toMatchObject({kind: 'pending', pending: {state: 'requesting'}});
  });
});

describe('ensureSupervisorAccount', () => {
  it('creates the system account, adds it to docker and returns its ids', async () => {
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === '/usr/bin/getent' && args[0] === 'passwd') return {code: 2, stdout: '', stderr: ''};
      if (file === '/usr/bin/id' && args[0] === '-nG') return {code: 0, stdout: 'siftable-supervisor\n', stderr: ''};
      if (file === '/usr/bin/id' && args[0] === '-u') return {code: 0, stdout: '998\n', stderr: ''};
      if (file === '/usr/bin/id' && args[0] === '-g') return {code: 0, stdout: '997\n', stderr: ''};
      return {code: 0, stdout: '', stderr: ''};
    };
    expect(await ensureSupervisorAccount(exec)).toEqual({uid: 998, gid: 997, created: true, dockerGroup: true});
    expect(calls).toContain('/usr/sbin/useradd --system --user-group --home-dir /var/lib/siftable-supervisor --no-create-home --shell /usr/sbin/nologin siftable-supervisor');
    expect(calls).toContain('/usr/sbin/usermod -aG docker siftable-supervisor');
  });

  it('refuses an account that resolves to root', async () => {
    const exec: Exec = async (file, args) => (file === '/usr/bin/id' && (args[0] === '-u' || args[0] === '-g')
      ? {code: 0, stdout: '0\n', stderr: ''} : {code: file === '/usr/bin/getent' && args[0] === 'group' ? 2 : 0, stdout: '', stderr: ''});
    await expect(ensureSupervisorAccount(exec)).rejects.toThrow(/unexpected uid/);
  });
});
