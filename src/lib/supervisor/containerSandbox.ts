/**
 * The agent container sandbox (first-run U2d-1), isolation profile v1.
 *
 * Patterned on Taster's provider launcher and the runtime daemon's digest and
 * network checks, but not a copy of either: containers here start as uid
 * 10001 with every capability dropped and none added, an explicit entrypoint
 * and working directory, a read-only root, and one internal network. What the
 * container is actually running under is read back from `docker inspect`,
 * never from the container, and every deviation is named.
 */

import {networkInterfaces} from 'node:os';

export const SANDBOX_USER = '10001:10001';
export const SANDBOX_LABEL_PREFIX = 'sift.machine.';
export const IMAGE_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,254}@sha256:[0-9a-f]{64}$/;

export interface SandboxMount {
  source: string;
  target: string;
}

/**
 * A named volume (the attempt filesystem's work, deps or src directory). A
 * subpath mounts one directory inside the volume, resolved by Docker within
 * the volume, never through a host path.
 */
export interface SandboxVolume {
  volume: string;
  target: string;
  readonly: boolean;
  subpath?: string;
}

export interface SandboxContainerSpec {
  name: string;
  imageRef: string;
  networkId: string;
  labels: Record<string, string>;
  entrypoint: string;
  command: string[];
  /** Read-only binds; the only host paths the container sees. */
  mounts: SandboxMount[];
  /** Named volumes, in mount order: a read-only whole volume before the writable subpaths over it. */
  volumes?: SandboxVolume[];
  /** Writable scratch, as `target` paths; mounted noexec, nosuid. */
  tmpfs: string[];
  env: Record<string, string>;
  limits: {cpus: number; memoryMb: number; pidsLimit: number};
  cgroupParent: string;
  /** The relay sidecar keeps stdin open for its frames. */
  interactive?: boolean;
  /** Working directory; /tmp unless the container works in its checkout. */
  workdir?: string;
}

/** Docker parses --mount as CSV, so a value with a comma, quote or newline would change the mount. */
const MOUNT_VALUE = /^[^,"\n\r]+$/;

function volumeMountArg(volume: SandboxVolume): string {
  for (const value of [volume.volume, volume.target, volume.subpath ?? 'x']) {
    if (!MOUNT_VALUE.test(value)) throw new Error(`A volume mount value cannot contain a comma, quote or newline: ${JSON.stringify(value)}`);
  }
  return [`type=volume`, `source=${volume.volume}`, `target=${volume.target}`,
    ...(volume.subpath ? [`volume-subpath=${volume.subpath}`] : []), ...(volume.readonly ? ['readonly'] : [])].join(',');
}

/** Scratch is bounded and cannot hold executables, setuid binaries or devices. */
export const TMPFS_OPTIONS = 'rw,noexec,nosuid,nodev,size=64m';

export function sandboxCreateArgs(spec: SandboxContainerSpec): string[] {
  if (!IMAGE_REF_PATTERN.test(spec.imageRef)) throw new Error('The sandbox image must be pinned by sha256 digest');
  for (const key of Object.keys(spec.labels)) {
    if (!key.startsWith(SANDBOX_LABEL_PREFIX)) throw new Error(`Sandbox label ${key} is outside ${SANDBOX_LABEL_PREFIX}`);
  }
  return [
    'container', 'create', '--pull', 'never', '--name', spec.name,
    '--user', SANDBOX_USER, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--network', spec.networkId, '--ipc', 'private', '--cgroupns', 'private', '--cgroup-parent', spec.cgroupParent,
    '--restart', 'no', '--pids-limit', String(spec.limits.pidsLimit),
    '--memory', `${spec.limits.memoryMb}m`, '--memory-swap', `${spec.limits.memoryMb}m`, '--cpus', String(spec.limits.cpus),
    '--entrypoint', spec.entrypoint, '--workdir', spec.workdir ?? '/tmp',
    ...spec.tmpfs.flatMap((target) => ['--tmpfs', `${target}:${TMPFS_OPTIONS}`]),
    ...spec.mounts.flatMap((mount) => ['--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`]),
    ...(spec.volumes ?? []).flatMap((volume) => ['--mount', volumeMountArg(volume)]),
    ...Object.entries(spec.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    ...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ...(spec.interactive ? ['--interactive'] : []),
    spec.imageRef, ...spec.command,
  ];
}

export interface SandboxExpectation {
  containerId: string;
  imageRef: string;
  /** The local image ID (`sha256:…`) that `docker image inspect` gave for imageRef. */
  imageId: string;
  networkId: string;
  spec: SandboxContainerSpec;
  /**
   * `created` checks a container before it starts: Docker attaches the network
   * endpoint only at start, so the requested network mode stands in for it.
   * `running` (the default) requires the attached endpoint itself.
   */
  phase?: 'created' | 'running';
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Checks `docker container inspect` against the spec it was created from, and
 * maps what it shows onto isolation profile v1. A field reports the profile's
 * value only when every check behind it passed.
 */
export function evaluateSandboxInspect(inspect: unknown, expected: SandboxExpectation): {
  problems: string[];
  observedImageRef: string;
  observedIsolation: Record<string, string | number | boolean>;
} {
  const container = obj(inspect);
  const config = obj(container.Config);
  const host = obj(container.HostConfig);
  const problems: string[] = [];
  const fail = (code: string) => { problems.push(code); return false; };
  const {spec} = expected;

  if (container.Id !== expected.containerId) fail('container_id');
  const imageOk = (container.Image === expected.imageId || fail('image_id')) && (config.Image === expected.imageRef || fail('image_ref'));

  const userOk = config.User === SANDBOX_USER || fail('user');
  const capsOk = (list(host.CapAdd).length === 0 || fail('cap_add'))
    && ((list(host.CapDrop).length === 1 && String(list(host.CapDrop)[0]).toUpperCase() === 'ALL') || fail('cap_drop'));
  const privilegedOk = host.Privileged === false || fail('privileged');
  const noNewPrivileges = list(host.SecurityOpt).some((option) => option === 'no-new-privileges:true' || option === 'no-new-privileges')
    || fail('no_new_privileges');
  const readOnlyRoot = host.ReadonlyRootfs === true || fail('read_only_root');
  const namespacesOk = (!['host'].includes(String(host.PidMode)) && !String(host.PidMode ?? '').startsWith('container:') || fail('pid_mode'))
    && (host.IpcMode === 'private' || fail('ipc_mode'))
    && (['', undefined, null].includes(host.UTSMode as never) || fail('uts_mode'))
    && (['', undefined, null].includes(host.UsernsMode as never) || fail('userns_mode'))
    && (host.CgroupnsMode === 'private' || fail('cgroupns_mode'));

  // Mounts: exactly the declared read-only binds, the declared volumes with their exact subpath and mode, and
  // the declared tmpfs targets; nothing from image defaults.
  const allowed = new Map(spec.mounts.map((mount) => [mount.target, mount.source]));
  const volumes = new Map((spec.volumes ?? []).map((volume) => [volume.target, volume]));
  const requested = new Map(list(host.Mounts).map(obj).map((mount) => [String(mount.Target), mount]));
  const mounts = list(container.Mounts).map(obj);
  const mountsOk = mounts.every((mount) => {
    const target = String(mount.Destination);
    if (mount.Type === 'volume') {
      const declared = volumes.get(target);
      if (!declared) return fail(`mount_type:${target}`);
      if (mount.Name !== declared.volume) return fail(`mount_unexpected:${target}`);
      if (mount.RW !== !declared.readonly) return fail(declared.readonly ? `mount_writable:${target}` : `mount_read_only:${target}`);
      const asked = requested.get(target);
      const subpath = obj(asked?.VolumeOptions).Subpath;
      if (!asked || asked.Source !== declared.volume || (subpath ?? undefined) !== declared.subpath
        || Boolean(asked.ReadOnly) !== declared.readonly) return fail(`mount_subpath:${target}`);
      return true;
    }
    if (mount.Type !== 'bind') return fail(`mount_type:${target}`);
    if (allowed.get(target) !== mount.Source) return fail(`mount_unexpected:${target}`);
    if (mount.RW !== false) return fail(`mount_writable:${target}`);
    return true;
  }) && (mounts.length === spec.mounts.length + volumes.size || fail('mount_count'));
  // Targets and their options: an exec-enabled or unbounded scratch is a different sandbox.
  const tmpfs = obj(host.Tmpfs);
  const tmpfsOk = (JSON.stringify(Object.keys(tmpfs).sort()) === JSON.stringify([...spec.tmpfs].sort()) || fail('tmpfs'))
    && (spec.tmpfs.every((target) => tmpfs[target] === TMPFS_OPTIONS) || fail('tmpfs_options'));
  const devicesOk = (list(host.Devices).length === 0 || fail('devices')) && (list(host.VolumesFrom).length === 0 || fail('volumes_from'));
  const socketMounted = mounts.some((mount) => /docker\.sock|containerd\.sock/.test(`${String(mount.Source)} ${String(mount.Destination)}`));
  const homeMounted = mounts.some((mount) => /^\/(root|home)(\/|$)/.test(String(mount.Source)) || /siftable-supervisor/.test(String(mount.Source)));

  const portsOk = (Object.keys(obj(host.PortBindings)).length === 0 || fail('port_bindings')) && (host.PublishAllPorts !== true || fail('publish_all'));
  const networks = Object.values(obj(obj(container.NetworkSettings).Networks)).map(obj);
  const networkOk = expected.phase === 'created'
    ? host.NetworkMode === expected.networkId || fail('network_mode')
    : (networks.length === 1 && networks[0].NetworkID === expected.networkId) || fail('networks');
  const restartOk = obj(host.RestartPolicy).Name === 'no' || fail('restart_policy');
  const limitsOk = (host.Memory === spec.limits.memoryMb * 1024 * 1024 || fail('memory'))
    // Swap equal to memory means none; -1 or a larger value would let the container page past its limit.
    && (host.MemorySwap === spec.limits.memoryMb * 1024 * 1024 || fail('memory_swap'))
    && (host.NanoCpus === Math.round(spec.limits.cpus * 1e9) || fail('cpus'))
    && (host.PidsLimit === spec.limits.pidsLimit || fail('pids_limit'));
  const cgroupOk = host.CgroupParent === spec.cgroupParent || fail('cgroup_parent');
  const entrypointOk = JSON.stringify(list(config.Entrypoint)) === JSON.stringify([spec.entrypoint]) || fail('entrypoint');
  const labels = obj(config.Labels);
  const labelsOk = Object.entries(spec.labels).every(([key, value]) => labels[key] === value) || fail('labels');

  const contained = imageOk && capsOk && privilegedOk && namespacesOk && devicesOk && portsOk && restartOk && limitsOk
    && entrypointOk && labelsOk;
  return {
    problems,
    observedImageRef: imageOk ? expected.imageRef : String(config.Image ?? ''),
    observedIsolation: {
      version: 1,
      user: userOk && contained ? 'unprivileged' : `observed:${String(config.User ?? 'root') || 'root'}`,
      readOnlyRoot: Boolean(readOnlyRoot),
      noNewPrivileges: Boolean(noNewPrivileges),
      hostHome: !(mountsOk && !homeMounted),
      dockerSocket: !(mountsOk && !socketMounted),
      network: networkOk && contained ? 'relay_only' : 'unverified',
      repository: mountsOk && tmpfsOk ? 'read_only_except_write_scope' : 'unverified',
      cgroup: cgroupOk && namespacesOk ? 'per_attempt' : 'unverified',
    },
  };
}

/**
 * Docker gives an internal network's bridge the gateway address, and host
 * services listening on all interfaces answer there. Gateway mode `isolated`
 * (Docker 28) leaves the bridge without an address; the subnet's first address
 * then goes to the first container. The host-side check below is that no host
 * address lies in the network's subnet.
 */
export const ISOLATED_GATEWAY_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';
export const MIN_DOCKER_MAJOR = 28;

/** The IPv4 addresses on this host's interfaces. */
export function hostIPv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flat().flatMap((entry) => (entry?.family === 'IPv4' ? [entry.address] : []));
}

function ipv4Value(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

/** True when the address is in the IPv4 subnet; null when the subnet cannot be read. */
export function ipv4InSubnet(address: string, cidr: string): boolean | null {
  const [base, bits] = cidr.split('/');
  const prefix = Number(bits);
  const network = ipv4Value(base ?? '');
  if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const value = ipv4Value(address);
  if (value === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(network / size);
}

/** The attempt network must be ours, internal, bridged, IPv4-only, without a host address, and hold exactly the expected containers. */
export function evaluateNetworkInspect(inspect: unknown, expected: {networkId: string; labels: Record<string, string>; containerIds: string[];
  hostAddresses: string[]}): string[] {
  const network = obj(inspect);
  const problems: string[] = [];
  if (network.Id !== expected.networkId) problems.push('network_id');
  if (network.Driver !== 'bridge') problems.push('network_driver');
  if (network.Internal !== true) problems.push('network_not_internal');
  if (network.EnableIPv6 === true) problems.push('network_ipv6');
  if (network.Scope !== 'local') problems.push('network_scope');
  if (network.Attachable === true || network.Ingress === true) problems.push('network_shared');
  if (obj(network.Options)[ISOLATED_GATEWAY_OPTION] !== 'isolated') problems.push('network_gateway_not_isolated');
  const config = obj(network.IPAM).Config;
  const subnets = (Array.isArray(config) ? config : []).map((entry) => obj(entry).Subnet).filter((subnet): subnet is string => typeof subnet === 'string');
  if (subnets.length === 0) problems.push('network_subnet_unknown');
  // An unreadable subnet counts as holding a host address.
  else if (expected.hostAddresses.some((address) => subnets.some((subnet) => ipv4InSubnet(address, subnet) !== false))) problems.push('network_host_address');
  const labels = obj(network.Labels);
  if (!Object.entries(expected.labels).every(([key, value]) => labels[key] === value)) problems.push('network_labels');
  const members = Object.keys(obj(network.Containers)).sort();
  if (JSON.stringify(members) !== JSON.stringify([...expected.containerIds].sort())) problems.push('network_members');
  return problems;
}

export function networkCreateArgs(name: string, labels: Record<string, string>): string[] {
  return ['network', 'create', '--driver', 'bridge', '--internal', '--opt', `${ISOLATED_GATEWAY_OPTION}=isolated`,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), name];
}

/** An older daemon may accept the option without honouring it, so the version is checked before any attempt. */
export function dockerVersionProblem(dockerInfo: {ServerVersion?: unknown}): string | null {
  const major = Number(/^(\d+)\./.exec(String(dockerInfo.ServerVersion ?? ''))?.[1]);
  return Number.isInteger(major) && major >= MIN_DOCKER_MAJOR ? null : `docker_${MIN_DOCKER_MAJOR}_required`;
}
