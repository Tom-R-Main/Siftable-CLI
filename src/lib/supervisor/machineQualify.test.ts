import {createHash, createPublicKey, verify} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {generateMachineKey, machineKeyFingerprint, rawEd25519PublicKey} from './machineProtocol.js';
import {type Attach, type Docker, MachineQualifyError, qualifyMachine, type QualifyDeps} from './machineQualify.js';
import {commitMachine, ensureStateDirectory, readJournal, writeCredential, writeKey} from './machineState.js';
import {MACHINE_ISOLATION_PROFILE_V1, machineCanonicalJson, machineQualificationSignedPayload} from './qualificationProtocol.js';

const API = 'https://api.example';
const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const ENROLLMENT = '33333333-3333-4333-8333-333333333333';
const RUNNER = '7a0c2a59-4f3e-4c1d-9b2e-5d6f7a8b9c0d';
const CREDENTIAL = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'sift_pat_supervisor';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const PASSING_PROBES = {probes: {
  read_supervisor_credential: {outcome: 'blocked', code: 'not_found'}, reach_provider_direct: {outcome: 'blocked', code: 'network_unreachable'},
  open_docker_socket: {outcome: 'blocked', code: 'not_found'}, see_host_processes: {outcome: 'blocked', code: 'ok'},
  reach_relay: {outcome: 'reached', code: 'ok'},
}};

/** A Docker that keeps what `container create` asked for and reports it back as Docker would. */
function fakeDocker(options: {failRemove?: boolean; privileged?: boolean} = {}) {
  const calls: string[][] = [];
  const containers = new Map<string, {args: string[]; name: string}>();
  let network: {id: string; labels: Record<string, string>} | undefined;
  const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
  const docker: Docker = async (args) => {
    calls.push(args);
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    const [a, b] = args;
    if (a === 'image' && b === 'inspect') return ok(JSON.stringify([{Id: IMAGE_ID, RepoDigests: [IMAGE]}]));
    if (a === 'network' && b === 'create') {
      network = {id: 'net-1', labels: Object.fromEntries(flag(args, '--label').map((l) => l.split('=') as [string, string]))};
      return ok('net-1\n');
    }
    if (a === 'network' && b === 'inspect') {
      return ok(JSON.stringify([{Id: 'net-1', Driver: 'bridge', Internal: true, EnableIPv6: false, Scope: 'local', Attachable: false,
        Ingress: false, Labels: network?.labels, IPAM: {Config: [{Gateway: '172.30.0.1'}]},
        Containers: Object.fromEntries([...containers.keys()].map((id) => [id, {}]))}]));
    }
    if (a === 'container' && b === 'create') {
      const name = flag(args, '--name')[0];
      const id = name.endsWith('-relay') ? 'sidecar-1' : 'probe-1';
      containers.set(id, {args, name});
      return ok(`${id}\n`);
    }
    if (a === 'container' && b === 'inspect' && args[2] === '--format') return ok('4242\n');
    if (a === 'container' && b === 'inspect') {
      return ok(JSON.stringify(args.slice(2).map((id) => {
        const created = containers.get(id)!.args;
        const image = created[created.indexOf('--interactive') + 1];
        const memory = Number(flag(created, '--memory')[0].replace('m', ''));
        return {
          Id: id, Image: IMAGE_ID,
          Config: {Image: image, User: flag(created, '--user')[0], Entrypoint: flag(created, '--entrypoint'),
            Labels: Object.fromEntries(flag(created, '--label').map((l) => l.split('=') as [string, string]))},
          HostConfig: {Privileged: options.privileged === true, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
            ReadonlyRootfs: true, PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private',
            CgroupParent: flag(created, '--cgroup-parent')[0], Devices: [], VolumesFrom: null, PortBindings: {}, PublishAllPorts: false,
            Tmpfs: Object.fromEntries(flag(created, '--tmpfs').map((t) => [t.split(':')[0], t.slice(t.indexOf(':') + 1)])),
            RestartPolicy: {Name: 'no'}, Memory: memory * 1024 * 1024, NanoCpus: Number(flag(created, '--cpus')[0]) * 1e9,
            PidsLimit: Number(flag(created, '--pids-limit')[0])},
          Mounts: flag(created, '--mount').map((m) => {
            const parts = Object.fromEntries(m.split(',').map((p) => p.split('=') as [string, string]));
            return {Type: 'bind', Source: parts.source, Destination: parts.target, RW: false};
          }),
          NetworkSettings: {Networks: {'sift-q': {NetworkID: 'net-1'}}},
        };
      })));
    }
    if (a === 'container' && b === 'ls') return ok('');
    if (a === 'network' && b === 'ls') return ok('');
    if (a === 'container' && b === 'rm') return options.failRemove ? {code: 1, stdout: '', stderr: 'device busy'} : ok();
    if (a === 'network' && b === 'rm') return ok();
    if (a === 'pull') return ok();
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return {docker, calls};
}

/** `docker start --attach`: the sidecar is a pipe pair; the probe prints its result line. */
function fakeAttach(probeLine: string) {
  const started: string[][] = [];
  const attach: Attach = (args) => {
    started.push(args);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    if (args.at(-1) === 'probe-1') setImmediate(() => stdout.write(`${probeLine}\n`));
    return {stdin, stdout, exited: Promise.resolve(0), kill: () => stdout.end()};
  };
  return {attach, started};
}

describe('qualifyMachine', () => {
  let root: string;
  let key: ReturnType<typeof generateMachineKey>;
  let publicKey: string;
  let posted: Array<{url: string; body: unknown}>;

  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(tmpdir(), 'sift-qualify-')), 'state');
    key = generateMachineKey();
    publicKey = rawEd25519PublicKey(key.privateKey);
    const state = {root, owner: null};
    await ensureStateDirectory(state);
    await writeKey(state, key.pem);
    await writeCredential(state, TOKEN);
    await commitMachine(state, {version: 1, apiUrl: API, enrollmentId: ENROLLMENT, runnerId: RUNNER,
      fingerprint: machineKeyFingerprint(publicKey), scope: {type: 'user'}, enrolledAt: '2026-10-29T05:00:00.000Z', credentialId: CREDENTIAL});
    posted = [];
  });
  afterEach(async () => fs.rm(path.dirname(root), {recursive: true, force: true}));

  const template = {probeSchemaVersion: 1, isolationProfileVersion: 1, isolationProfile: MACHINE_ISOLATION_PROFILE_V1, imageRef: IMAGE};
  const binding = (overrides: object = {}) => ({
    context: 'sift.machine.supervisor.qualification.v1', purpose: 'qualification', version: 1,
    challengeId: '44444444-4444-4444-8444-444444444444', userId: '22222222-2222-4222-8222-222222222222', orgId: null,
    enrollmentId: ENROLLMENT, runnerId: RUNNER, keyFingerprint: machineKeyFingerprint(publicKey), enrolledTokenId: CREDENTIAL,
    templateDigest: sha256(machineCanonicalJson(template)), expiresAt: '2026-10-29T05:10:00.000Z', ...overrides,
  });
  function fakeFetch(options: {binding?: object; template?: object; loseReport?: boolean} = {}) {
    return (async (url: string | URL, init: RequestInit = {}) => {
      const target = String(url);
      expect(init.redirect).toBe('error');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      if (target.endsWith('/qualification-challenges')) {
        return new Response(JSON.stringify({nonce: 'n'.repeat(43), template: options.template ?? template, binding: binding(options.binding)}), {status: 201});
      }
      if (target.endsWith('/qualification')) {
        const body = JSON.parse(String(init.body));
        posted.push({url: target, body});
        if (options.loseReport && posted.length === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({outcome: 'qualified', receipt: {failures: []}}), {status: 200});
      }
      throw new Error(`unexpected ${target}`);
    }) as typeof fetch;
  }
  const deps = (overrides: Partial<QualifyDeps> = {}): QualifyDeps => ({
    fetch: fakeFetch(), docker: fakeDocker().docker, attach: fakeAttach(JSON.stringify(PASSING_PROBES)).attach,
    state: {root, owner: null}, now: () => new Date('2026-10-29T05:01:00Z'), log: () => undefined,
    readHostCgroup: async () => '0::/siftable.slice/docker-probe-1.scope\n',
    assets: {probe: '/usr/lib/sift/probe.js', sidecar: '/usr/lib/sift/sidecar.js'}, ...overrides,
  });

  it('runs the probes in the sandbox, reports what Docker and the host show, signs it and cleans up', async () => {
    const docker = fakeDocker();
    const attach = fakeAttach(JSON.stringify(PASSING_PROBES));
    const result = await qualifyMachine(deps({docker: docker.docker, attach: attach.attach}));
    expect(result).toEqual({outcome: 'qualified', failures: [], problems: [], held: []});
    const {body} = posted[0] as {body: {report: {observedIsolation: object; observedImageRef: string}; signature: string; nonce: string}};
    expect(body.report.observedIsolation).toEqual({...MACHINE_ISOLATION_PROFILE_V1});
    expect(body.report.observedImageRef).toBe(IMAGE);
    const payload = machineQualificationSignedPayload(binding() as never, body.nonce, sha256(machineCanonicalJson(body.report)));
    expect(verify(null, Buffer.from(payload), createPublicKey(key.privateKey), Buffer.from(body.signature, 'base64url'))).toBe(true);
    expect(attach.started.map((args) => args.at(-1))).toEqual(['sidecar-1', 'probe-1']);
    expect(docker.calls.filter((args) => args[1] === 'rm').map((args) => args.at(-1))).toEqual(['sidecar-1', 'probe-1', 'net-1']);
    expect(await readJournal({root, owner: null}, 'qualify-journal.json')).toBeNull();
  });

  it.each([
    ['enrolledTokenId', {enrolledTokenId: '00000000-0000-4000-8000-000000000000'}],
    ['orgId', {orgId: '11111111-2222-4333-8444-555555555555'}],
    ['keyFingerprint', {keyFingerprint: 'e'.repeat(64)}],
  ])('launches nothing when the challenge names another %s', async (field, overrides) => {
    const docker = fakeDocker();
    await expect(qualifyMachine(deps({docker: docker.docker, fetch: fakeFetch({binding: overrides})}))).rejects.toThrow(field);
    expect(docker.calls).toEqual([]);
  });

  it('launches nothing when the template does not match its digest or is not pinned', async () => {
    const docker = fakeDocker();
    await expect(qualifyMachine(deps({docker: docker.docker, fetch: fakeFetch({template: {...template, imageRef: `${IMAGE.slice(0, -1)}b`}})})))
      .rejects.toBeInstanceOf(MachineQualifyError);
    await expect(qualifyMachine(deps({docker: docker.docker, fetch: fakeFetch({template: {...template, imageRef: 'agent:latest'}})})))
      .rejects.toThrow(/pinned/);
    expect(docker.calls).toEqual([]);
  });

  it('resends the identical signed report after a lost reply, without running anything again', async () => {
    await expect(qualifyMachine(deps({fetch: fakeFetch({loseReport: true})}))).rejects.toThrow(/resends the same signed report/);
    expect(await readJournal<{state: string}>({root, owner: null}, 'qualify-journal.json')).toMatchObject({state: 'report_pending'});
    const docker = fakeDocker();
    const fetchImpl = fakeFetch();
    await qualifyMachine(deps({docker: docker.docker, fetch: fetchImpl}));
    expect(docker.calls).toEqual([]);
    expect(posted[1].body).toEqual(posted[0].body);
  });

  it('keeps resources it could not remove held, and will not qualify again until they are gone', async () => {
    const failing = fakeDocker({failRemove: true});
    const result = await qualifyMachine(deps({docker: failing.docker}));
    expect(result.held).toEqual(['container:sidecar-1', 'container:probe-1']);
    expect(await readJournal<{state: string}>({root, owner: null}, 'qualify-journal.json')).toMatchObject({state: 'held'});
    await expect(qualifyMachine(deps({docker: fakeDocker({failRemove: true}).docker}))).rejects.toThrow(/could not be removed/);
    // Once removal works, the next run qualifies normally.
    expect(await qualifyMachine(deps())).toMatchObject({outcome: 'qualified', held: []});
  });

  it('reports the cgroup unverified when the probe is not under the attempt slice', async () => {
    const result = await qualifyMachine(deps({readHostCgroup: async () => '0::/system.slice/docker-probe-1.scope\n'}));
    expect(result.problems).toContain('probe:cgroup_membership');
    expect((posted[0].body as {report: {observedIsolation: {cgroup: string}}}).report.observedIsolation.cgroup).toBe('unverified');
  });

  it('reports a deviation Docker shows, and malformed probe output as errors', async () => {
    const result = await qualifyMachine(deps({docker: fakeDocker({privileged: true}).docker, attach: fakeAttach('not json').attach}));
    expect(result.problems).toEqual(expect.arrayContaining(['relay:privileged', 'probe:privileged']));
    const report = (posted[0].body as {report: {observedIsolation: object; probes: Record<string, {outcome: string}>}}).report;
    expect(report.observedIsolation).not.toEqual({...MACHINE_ISOLATION_PROFILE_V1});
    expect(Object.values(report.probes).every((probe) => probe.outcome === 'error')).toBe(true);
  });
});
