/**
 * `sift machine qualify` (first-run U2d-1b): run the isolation probes inside
 * the pinned agent image on an internal network whose only other member is
 * the relay sidecar, read back what Docker and the host actually applied,
 * sign the report with the enrollment key and submit it.
 *
 * Journal rules (U2d contract rev 2; Release #17000, DB #17004):
 * - Each effect is journaled before it happens: challenge, network and
 *   container creation, the signed report.
 * - Teardown removes exact IDs, then sweeps this run's labels. A removal that
 *   fails stays `held` and is never reported as clean.
 * - A report whose submission got no reply is resent byte for byte.
 * - Qualification is not proof of host cleanup.
 */
import {createHash, createPrivateKey, randomBytes, sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {
  evaluateNetworkInspect,
  evaluateSandboxInspect,
  IMAGE_REF_PATTERN,
  networkCreateArgs,
  sandboxCreateArgs,
  type SandboxContainerSpec,
} from './containerSandbox.js';
import {fetchOwnEnrollment, MachineEnrollError} from './machineEnroll.js';
import {
  acquireStateLock,
  inspectMachineState,
  type MachineRecord,
  type MachineStateOptions,
  readCredential,
  readJournal,
  readKey,
  removeJournal,
  updateMachine,
  writeJournal,
} from './machineState.js';
import {
  MACHINE_PROBE_CODES,
  MACHINE_QUALIFICATION_CONTEXT,
  MACHINE_QUALIFICATION_PURPOSE,
  MACHINE_QUALIFICATION_VERSION,
  MACHINE_REQUIRED_PROBES,
  machineCanonicalJson,
  type MachineQualificationBinding,
  type MachineQualificationReport,
  machineQualificationSignedPayload,
  type MachineQualificationTemplate,
} from './qualificationProtocol.js';
import {DIAGNOSTIC_PATH, SIDECAR_PORT} from './relaySidecar.js';
import {diagnosticHandler, serveSidecarFrames} from './sidecarBridge.js';

const JOURNAL = 'qualify-journal.json';
export const QUALIFY_CGROUP_PARENT = 'siftable.slice';
const PROBE_OUTPUT_TIMEOUT_MS = 90_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Docker = (args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;
export interface AttachedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  exited: Promise<number>;
  kill: () => void;
}
export type Attach = (args: string[]) => AttachedProcess;

export interface QualifyDeps {
  fetch: typeof fetch;
  docker: Docker;
  attach: Attach;
  state: MachineStateOptions;
  now: () => Date;
  log: (line: string) => void;
  /** Contents of /proc/<pid>/cgroup on the host. */
  readHostCgroup: (pid: number) => Promise<string>;
  /** Host paths of the shipped probe and sidecar programs, mounted read-only. */
  assets: {probe: string; sidecar: string};
}

export interface QualifyResult {
  outcome: 'qualified' | 'refused';
  failures: string[];
  /** Local findings from inspect, the network and the cgroup check. */
  problems: string[];
  /** Resources that could not be removed; they stay journaled. */
  held: string[];
}

interface QualifyJournal {
  version: 1;
  runId: string;
  state: 'issued' | 'running' | 'report_pending' | 'held';
  challenge?: {binding: MachineQualificationBinding; nonce: string; template: MachineQualificationTemplate};
  networkId?: string;
  containers: {sidecar?: string; probe?: string};
  report?: {canonical: string; signature: string};
  problems?: string[];
  held?: string[];
}

export class MachineQualifyError extends Error {}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function mustDocker(docker: Docker, args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) throw new MachineQualifyError(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`);
  return result.stdout.trim();
}

/** Every check of the server's binding against what this machine holds, before anything is launched. */
export function checkBinding(binding: MachineQualificationBinding, machine: MachineRecord & {credentialId: string}, now: Date): void {
  const expectedOrg = machine.scope.type === 'workspace' ? machine.scope.id : null;
  const mismatches = [
    binding.context !== MACHINE_QUALIFICATION_CONTEXT && 'context',
    binding.purpose !== MACHINE_QUALIFICATION_PURPOSE && 'purpose',
    binding.version !== MACHINE_QUALIFICATION_VERSION && 'version',
    !UUID.test(String(binding.challengeId)) && 'challengeId',
    binding.enrollmentId !== machine.enrollmentId && 'enrollmentId',
    binding.runnerId !== machine.runnerId && 'runnerId',
    binding.keyFingerprint !== machine.fingerprint && 'keyFingerprint',
    binding.enrolledTokenId !== machine.credentialId && 'enrolledTokenId',
    binding.orgId !== expectedOrg && 'orgId',
    !(Date.parse(binding.expiresAt) > now.getTime()) && 'expiresAt',
  ].filter(Boolean);
  if (mismatches.length > 0) throw new MachineQualifyError(`The server's challenge does not match this machine (${mismatches.join(', ')}). Nothing was launched.`);
}

export function checkTemplate(template: MachineQualificationTemplate, binding: MachineQualificationBinding): void {
  if (!IMAGE_REF_PATTERN.test(String(template?.imageRef))) throw new MachineQualifyError('The challenge names an image that is not pinned by digest.');
  if (sha256(machineCanonicalJson(template)) !== binding.templateDigest) {
    throw new MachineQualifyError('The challenge\'s template does not match its digest. Nothing was launched.');
  }
}

/** Probe output, strictly: exactly the required probes with known outcomes and codes; anything else is an error result. */
export function parseProbeOutput(line: string | undefined): MachineQualificationReport['probes'] {
  const fallback = Object.fromEntries(Object.keys(MACHINE_REQUIRED_PROBES).map((id) => [id, {outcome: 'error', code: 'unexpected_error'}]));
  let parsed: unknown;
  try {
    parsed = JSON.parse(line ?? '');
  } catch {
    return fallback as MachineQualificationReport['probes'];
  }
  const probes = (parsed as {probes?: Record<string, {outcome?: unknown; code?: unknown}>})?.probes ?? {};
  const result: Record<string, {outcome: string; code: string}> = {};
  for (const id of Object.keys(MACHINE_REQUIRED_PROBES)) {
    const probe = Object.prototype.hasOwnProperty.call(probes, id) ? probes[id] : undefined;
    const valid = probe && ['blocked', 'reached', 'error'].includes(String(probe.outcome))
      && (MACHINE_PROBE_CODES as readonly string[]).includes(String(probe.code));
    result[id] = valid ? {outcome: String(probe.outcome), code: String(probe.code)} : {outcome: 'error', code: 'unexpected_error'};
  }
  return result as MachineQualificationReport['probes'];
}

/** The pinned image, present locally, and its local ID. */
async function ensureImage(docker: Docker, imageRef: string): Promise<string> {
  let inspected = await docker(['image', 'inspect', imageRef]);
  if (inspected.code !== 0) {
    await mustDocker(docker, ['pull', imageRef]);
    inspected = await docker(['image', 'inspect', imageRef]);
  }
  if (inspected.code !== 0) throw new MachineQualifyError(`The agent image ${imageRef} is not available.`);
  const [image] = JSON.parse(inspected.stdout) as Array<{Id?: string; RepoDigests?: string[]}>;
  if (!image?.Id || !(image.RepoDigests ?? []).includes(imageRef)) throw new MachineQualifyError('The local image does not carry the pinned digest.');
  return image.Id;
}

/** Removes exactly what this run created; whatever cannot be removed is returned and stays held. */
async function teardown(docker: Docker, journal: QualifyJournal): Promise<string[]> {
  const held: string[] = [];
  const label = `label=sift.machine.run=${journal.runId}`;
  const listed = await docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', label]);
  const containers = new Set([...Object.values(journal.containers).filter(Boolean) as string[],
    ...(listed.code === 0 ? listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  if (listed.code !== 0) held.push(`containers:${journal.runId}`);
  for (const id of containers) {
    const removed = await docker(['container', 'rm', '--force', '--volumes', id]);
    if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) held.push(`container:${id}`);
  }
  const networks = await docker(['network', 'ls', '--quiet', '--no-trunc', '--filter', label]);
  const ids = new Set([...(journal.networkId ? [journal.networkId] : []),
    ...(networks.code === 0 ? networks.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  if (networks.code !== 0) held.push(`networks:${journal.runId}`);
  for (const id of ids) {
    const removed = await docker(['network', 'rm', id]);
    if (removed.code !== 0 && !/No such network|not found/i.test(removed.stderr)) held.push(`network:${id}`);
  }
  return held;
}

function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    const done = (value: string | undefined) => { clearTimeout(timer); stream.removeAllListeners('data'); resolve(value); };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline >= 0) done(buffer.slice(0, newline));
      else if (buffer.length > 65_536) done(undefined);
    });
    stream.once('end', () => done(buffer.length > 0 ? buffer : undefined));
  });
}

async function submit(deps: QualifyDeps, machine: MachineRecord, token: string, journal: QualifyJournal): Promise<QualifyResult> {
  const {challenge, report} = journal;
  if (!challenge || !report) throw new MachineQualifyError('The qualification journal is missing its report.');
  let response: Response;
  try {
    response = await deps.fetch(`${machine.apiUrl}/api/v1/machines/enrollments/${machine.enrollmentId}/qualification`, {
      method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({challengeId: challenge.binding.challengeId, nonce: challenge.nonce,
        report: JSON.parse(report.canonical) as unknown, signature: report.signature}),
    });
  } catch {
    throw new MachineQualifyError('The qualification report got no reply. Run `sift machine qualify` again; it resends the same signed report.');
  }
  const body = await response.json().catch(() => null) as {outcome?: string; receipt?: {failures?: string[]}; detail?: string} | null;
  if (!response.ok || (body?.outcome !== 'qualified' && body?.outcome !== 'refused')) {
    if (response.status === 409 || response.status === 403) {
      await writeJournal(deps.state, JOURNAL, {...journal, state: journal.held?.length ? 'held' : 'report_pending', report: undefined});
      if (!journal.held?.length) await removeJournal(deps.state, JOURNAL);
    }
    throw new MachineQualifyError(`The server did not accept the report (HTTP ${response.status}${body?.detail ? `: ${body.detail}` : ''}).`);
  }
  if (journal.held?.length) await writeJournal(deps.state, JOURNAL, {...journal, state: 'held', report: undefined});
  else await removeJournal(deps.state, JOURNAL);
  return {outcome: body.outcome, failures: body.receipt?.failures ?? [], problems: journal.problems ?? [], held: journal.held ?? []};
}

function specs(runId: string, imageRef: string, networkId: string, enrollmentId: string, nonce: string, gateway: string, assets: QualifyDeps['assets']) {
  const labels = (role: string) => ({'sift.machine.run': runId, 'sift.machine.role': role, 'sift.machine.enrollment': enrollmentId});
  const sidecarName = `sift-q-${runId}-relay`;
  const base = {imageRef, networkId, entrypoint: 'node', tmpfs: ['/tmp'], cgroupParent: QUALIFY_CGROUP_PARENT,
    limits: {cpus: 0.5, memoryMb: 256, pidsLimit: 64}, interactive: true};
  const sidecar: SandboxContainerSpec = {...base, name: sidecarName, labels: labels('relay'), command: ['/sift/sidecar.cjs'],
    mounts: [{source: assets.sidecar, target: '/sift/sidecar.cjs'}], env: {}};
  const probe: SandboxContainerSpec = {...base, name: `sift-q-${runId}-probe`, labels: labels('probe'), command: ['/sift/probe.cjs'],
    mounts: [{source: assets.probe, target: '/sift/probe.cjs'}],
    env: {
      SIFT_DIAGNOSTIC_URL: `http://${sidecarName}:${SIDECAR_PORT}${DIAGNOSTIC_PATH}`,
      SIFT_DIAGNOSTIC_NONCE: nonce,
      SIFT_PROBE_ESCAPE_ADDRESSES: [`1.1.1.1:443`, ...(gateway ? [`${gateway}:80`] : []), '169.254.169.254:80'].join(','),
      SIFT_PROBE_HOLD: '1',
    }};
  return {sidecar, probe, networkLabels: labels('network')};
}

export async function qualifyMachine(deps: QualifyDeps): Promise<QualifyResult> {
  const release = await acquireStateLock(deps.state);
  try {
    const state = await inspectMachineState(deps.state);
    if (state.kind !== 'enrolled') throw new MachineQualifyError('This machine is not enrolled. Run `sudo sift machine enroll` first.');
    let machine = state.machine;
    const token = await readCredential(deps.state);
    const pem = await readKey(deps.state);
    if (!token || !pem) throw new MachineQualifyError('The enrollment credential or key is missing.');
    if (!machine.credentialId) {
      try {
        machine = {...machine, credentialId: (await fetchOwnEnrollment(deps.fetch, machine, token)).credentialId};
      } catch (error) {
        throw new MachineQualifyError((error as MachineEnrollError).message);
      }
      await updateMachine(deps.state, machine);
    }
    const known = {...machine, credentialId: machine.credentialId as string};

    const earlier = await readJournal<QualifyJournal>(deps.state, JOURNAL);
    if (earlier?.state === 'report_pending') return await submit(deps, known, token, earlier);
    if (earlier) {
      const held = await teardown(deps.docker, earlier);
      if (held.length > 0) {
        await writeJournal(deps.state, JOURNAL, {...earlier, state: 'held', held});
        throw new MachineQualifyError(`An earlier qualification left resources that could not be removed (${held.join(', ')}). Remove them, then run again.`);
      }
      await removeJournal(deps.state, JOURNAL);
    }

    let issued: Response;
    try {
      issued = await deps.fetch(`${known.apiUrl}/api/v1/machines/enrollments/${known.enrollmentId}/qualification-challenges`, {
        method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${token}`},
      });
    } catch {
      throw new MachineQualifyError('Could not reach the API for a qualification challenge. Run the command again.');
    }
    const challenge = await issued.json().catch(() => null) as {nonce?: string; template?: MachineQualificationTemplate; binding?: MachineQualificationBinding; detail?: string} | null;
    if (!issued.ok || !challenge?.binding || !challenge.template || typeof challenge.nonce !== 'string') {
      throw new MachineQualifyError(`The server issued no challenge (HTTP ${issued.status}${challenge?.detail ? `: ${challenge.detail}` : ''}).`);
    }
    checkBinding(challenge.binding, known, deps.now());
    checkTemplate(challenge.template, challenge.binding);

    const runId = randomBytes(6).toString('hex');
    let journal: QualifyJournal = {version: 1, runId, state: 'issued', containers: {},
      challenge: {binding: challenge.binding, nonce: challenge.nonce, template: challenge.template}};
    await writeJournal(deps.state, JOURNAL, journal);

    const imageRef = challenge.template.imageRef;
    const imageId = await ensureImage(deps.docker, imageRef);
    const diagnosticNonce = randomBytes(16).toString('hex');
    const problems: string[] = [];
    let probes: MachineQualificationReport['probes'];
    let observedImageRef = '';
    let observedIsolation: Record<string, string | number | boolean> = {};
    let sidecar: AttachedProcess | undefined;
    let probe: AttachedProcess | undefined;
    try {
      journal = {...journal, state: 'running'};
      await writeJournal(deps.state, JOURNAL, journal);
      const labelsOnly = specs(runId, imageRef, '', known.enrollmentId, diagnosticNonce, '', deps.assets).networkLabels;
      const networkId = await mustDocker(deps.docker, networkCreateArgs(`sift-q-${runId}`, labelsOnly));
      journal = {...journal, networkId};
      await writeJournal(deps.state, JOURNAL, journal);
      const [network] = JSON.parse(await mustDocker(deps.docker, ['network', 'inspect', networkId])) as Array<{IPAM?: {Config?: Array<{Gateway?: string}>}}>;
      const gateway = network?.IPAM?.Config?.[0]?.Gateway ?? '';
      const plan = specs(runId, imageRef, networkId, known.enrollmentId, diagnosticNonce, gateway, deps.assets);
      const sidecarId = await mustDocker(deps.docker, sandboxCreateArgs(plan.sidecar));
      journal = {...journal, containers: {...journal.containers, sidecar: sidecarId}};
      await writeJournal(deps.state, JOURNAL, journal);
      const probeId = await mustDocker(deps.docker, sandboxCreateArgs(plan.probe));
      journal = {...journal, containers: {...journal.containers, probe: probeId}};
      await writeJournal(deps.state, JOURNAL, journal);

      const inspected = JSON.parse(await mustDocker(deps.docker, ['container', 'inspect', sidecarId, probeId])) as unknown[];
      const byId = new Map(inspected.map((entry) => [(entry as {Id?: string}).Id, entry]));
      const sidecarCheck = evaluateSandboxInspect(byId.get(sidecarId), {containerId: sidecarId, imageRef, imageId, networkId, spec: plan.sidecar});
      const probeCheck = evaluateSandboxInspect(byId.get(probeId), {containerId: probeId, imageRef, imageId, networkId, spec: plan.probe});
      const [networkAfter] = JSON.parse(await mustDocker(deps.docker, ['network', 'inspect', networkId])) as unknown[];
      const networkProblems = evaluateNetworkInspect(networkAfter, {networkId, labels: plan.networkLabels, containerIds: [sidecarId, probeId]});
      problems.push(...sidecarCheck.problems.map((p) => `relay:${p}`), ...probeCheck.problems.map((p) => `probe:${p}`), ...networkProblems);
      observedImageRef = probeCheck.observedImageRef;
      observedIsolation = {...probeCheck.observedIsolation};
      if (sidecarCheck.problems.length > 0 || networkProblems.length > 0) observedIsolation.network = 'unverified';

      sidecar = deps.attach(['start', '--attach', '--interactive', sidecarId]);
      serveSidecarFrames(sidecar.stdout, sidecar.stdin, diagnosticHandler(diagnosticNonce, DIAGNOSTIC_PATH));
      probe = deps.attach(['start', '--attach', '--interactive', probeId]);
      const line = await readFirstLine(probe.stdout, PROBE_OUTPUT_TIMEOUT_MS);
      probes = parseProbeOutput(line);
      // Actual cgroup membership, read on the host while the probe still runs.
      const pid = Number(await mustDocker(deps.docker, ['container', 'inspect', '--format', '{{.State.Pid}}', probeId]));
      const cgroup = Number.isInteger(pid) && pid > 0 ? await deps.readHostCgroup(pid).catch(() => '') : '';
      if (!cgroup.split('\n').some((entry) => entry.includes(`/${QUALIFY_CGROUP_PARENT}/`))) {
        problems.push('probe:cgroup_membership');
        observedIsolation.cgroup = 'unverified';
      }
    } catch (error) {
      if (!(error instanceof MachineQualifyError)) throw error;
      problems.push(`launch:${error.message.slice(0, 120)}`);
      probes = parseProbeOutput(undefined);
      observedIsolation = {...observedIsolation, network: 'unverified'};
    } finally {
      probe?.stdin.end();
      probe?.kill();
      sidecar?.kill();
    }
    const held = await teardown(deps.docker, journal);

    const report: MachineQualificationReport = {probes, observedImageRef, observedIsolation, completedAt: deps.now().toISOString()};
    const canonical = machineCanonicalJson(report);
    const signature = sign(null, Buffer.from(machineQualificationSignedPayload(challenge.binding, challenge.nonce, sha256(canonical))),
      createPrivateKey(pem)).toString('base64url');
    journal = {...journal, state: 'report_pending', report: {canonical, signature}, problems, held};
    await writeJournal(deps.state, JOURNAL, journal);
    return await submit(deps, known, token, journal);
  } finally {
    await release();
  }
}

/** The shipped probe and sidecar programs, beside this module in dist. */
export function shippedAssets(): QualifyDeps['assets'] {
  return {probe: path.join(__dirname, 'qualificationProbe.js'), sidecar: path.join(__dirname, 'relaySidecar.js')};
}

export const readProcCgroup = (pid: number) => fs.readFile(`/proc/${pid}/cgroup`, 'utf8');
