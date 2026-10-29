import {describe, expect, it} from 'vitest';
import {
  dockerVersionProblem,
  evaluateNetworkInspect,
  evaluateSandboxInspect,
  networkCreateArgs,
  sandboxCreateArgs,
  type SandboxContainerSpec,
} from './containerSandbox.js';
import {MACHINE_ISOLATION_PROFILE_V1} from './qualificationProtocol.js';

const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const spec: SandboxContainerSpec = {
  name: 'sift-qualify-probe-1', imageRef: IMAGE, networkId: 'net-1',
  labels: {'sift.machine.run': 'run-1', 'sift.machine.role': 'probe'},
  entrypoint: 'node', command: ['/sift/probe.mjs'],
  mounts: [{source: '/usr/lib/sift/probe.mjs', target: '/sift/probe.mjs'}],
  tmpfs: ['/tmp'], env: {SIFT_DIAGNOSTIC_URL: 'http://relay:8787/sift/v1/diagnostic'},
  limits: {cpus: 0.5, memoryMb: 256, pidsLimit: 64}, cgroupParent: 'siftable.slice',
};

/** What `docker container inspect` reports for a container created from `spec`. */
function inspectOf(overrides: {config?: object; host?: object; mounts?: object[]; networks?: object} = {}) {
  return {
    Id: 'container-1', Image: IMAGE_ID,
    Config: {Image: IMAGE, User: '10001:10001', Entrypoint: ['node'], Labels: {...spec.labels}, ...overrides.config},
    HostConfig: {
      Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true,
      PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private', CgroupParent: 'siftable.slice',
      Tmpfs: {'/tmp': 'rw,noexec,nosuid,nodev,size=64m'}, Devices: [], VolumesFrom: null, PortBindings: {}, PublishAllPorts: false,
      RestartPolicy: {Name: 'no'}, Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, NanoCpus: 0.5e9, PidsLimit: 64, ...overrides.host,
    },
    Mounts: overrides.mounts ?? [{Type: 'bind', Source: '/usr/lib/sift/probe.mjs', Destination: '/sift/probe.mjs', RW: false}],
    NetworkSettings: {Networks: overrides.networks ?? {'sift-net': {NetworkID: 'net-1'}}},
  };
}
const expected = {containerId: 'container-1', imageRef: IMAGE, imageId: IMAGE_ID, networkId: 'net-1', spec};

describe('sandboxCreateArgs', () => {
  it('starts unprivileged, read-only and on one internal network, with an explicit entrypoint', () => {
    const args = sandboxCreateArgs(spec);
    expect(args.slice(0, 6)).toEqual(['container', 'create', '--pull', 'never', '--name', 'sift-qualify-probe-1']);
    for (const pair of [['--user', '10001:10001'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges:true'],
      ['--network', 'net-1'], ['--ipc', 'private'], ['--cgroupns', 'private'], ['--restart', 'no'], ['--entrypoint', 'node'],
      ['--mount', 'type=bind,source=/usr/lib/sift/probe.mjs,target=/sift/probe.mjs,readonly']]) {
      expect(args.join('\u0000')).toContain(pair.join('\u0000'));
    }
    expect(args).toContain('--read-only');
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('--privileged');
    expect(args.slice(-2)).toEqual([IMAGE, '/sift/probe.mjs']);
  });

  it('refuses an unpinned image and labels outside its namespace', () => {
    expect(() => sandboxCreateArgs({...spec, imageRef: 'registry.example/sift-agent:latest'})).toThrow(/sha256/);
    expect(() => sandboxCreateArgs({...spec, labels: {owner: 'x'}})).toThrow(/outside/);
  });
});

describe('evaluateSandboxInspect', () => {
  it('maps a correctly created container exactly onto isolation profile v1', () => {
    const result = evaluateSandboxInspect(inspectOf(), expected);
    expect(result.problems).toEqual([]);
    expect(result.observedImageRef).toBe(IMAGE);
    expect(result.observedIsolation).toEqual({...MACHINE_ISOLATION_PROFILE_V1});
  });

  it.each([
    ['privileged', {host: {Privileged: true}}],
    ['cap_add', {host: {CapAdd: ['NET_ADMIN']}}],
    ['cap_drop', {host: {CapDrop: []}}],
    ['user', {config: {User: '0'}}],
    ['no_new_privileges', {host: {SecurityOpt: []}}],
    ['read_only_root', {host: {ReadonlyRootfs: false}}],
    ['pid_mode', {host: {PidMode: 'host'}}],
    ['pid_mode', {host: {PidMode: 'container:abc'}}],
    ['ipc_mode', {host: {IpcMode: 'host'}}],
    ['userns_mode', {host: {UsernsMode: 'host'}}],
    ['cgroupns_mode', {host: {CgroupnsMode: 'host'}}],
    ['devices', {host: {Devices: [{PathOnHost: '/dev/kvm'}]}}],
    ['volumes_from', {host: {VolumesFrom: ['other']}}],
    ['port_bindings', {host: {PortBindings: {'8787/tcp': [{HostPort: '8787'}]}}}],
    ['restart_policy', {host: {RestartPolicy: {Name: 'always'}}}],
    ['memory', {host: {Memory: 0}}],
    ['memory_swap', {host: {MemorySwap: -1}}],
    ['memory_swap', {host: {MemorySwap: 2 * 256 * 1024 * 1024}}],
    ['tmpfs_options', {host: {Tmpfs: {'/tmp': 'rw,exec,suid,dev,size=100g'}}}],
    ['tmpfs', {host: {Tmpfs: {'/tmp': 'rw,noexec,nosuid,nodev,size=64m', '/var/tmp': 'rw'}}}],
    ['cgroup_parent', {host: {CgroupParent: ''}}],
    ['entrypoint', {config: {Entrypoint: ['/bin/sh', '-c']}}],
    ['networks', {networks: {a: {NetworkID: 'net-1'}, b: {NetworkID: 'bridge'}}}],
    ['mount_type:/data', {mounts: [{Type: 'bind', Source: '/usr/lib/sift/probe.mjs', Destination: '/sift/probe.mjs', RW: false},
      {Type: 'volume', Source: '/var/lib/docker/volumes/x', Destination: '/data', RW: true}]}],
    ['mount_unexpected:/var/run/docker.sock', {mounts: [{Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false}]}],
    ['mount_writable:/sift/probe.mjs', {mounts: [{Type: 'bind', Source: '/usr/lib/sift/probe.mjs', Destination: '/sift/probe.mjs', RW: true}]}],
  ] as const)('rejects %s and never reports the full profile', (problem, overrides) => {
    const result = evaluateSandboxInspect(inspectOf(overrides as never), expected);
    expect(result.problems).toContain(problem);
    expect(result.observedIsolation).not.toEqual({...MACHINE_ISOLATION_PROFILE_V1});
  });

  it('checks the requested network mode before start, and the attached endpoint once running', () => {
    const created = inspectOf({host: {NetworkMode: 'net-1'}, networks: {'sift-net': {NetworkID: ''}}});
    expect(evaluateSandboxInspect(created, {...expected, phase: 'created'}).problems).toEqual([]);
    expect(evaluateSandboxInspect(created, expected).problems).toContain('networks');
    expect(evaluateSandboxInspect(inspectOf({host: {NetworkMode: 'bridge'}}), {...expected, phase: 'created'}).problems).toContain('network_mode');
  });

  it('rejects another image behind the same reference', () => {
    const result = evaluateSandboxInspect({...inspectOf(), Image: `sha256:${'c'.repeat(64)}`}, expected);
    expect(result.problems).toContain('image_id');
  });
});

describe('evaluateNetworkInspect', () => {
  const network = {Id: 'net-1', Driver: 'bridge', Internal: true, EnableIPv6: false, Scope: 'local', Attachable: false, Ingress: false,
    Options: {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'}, Labels: {'sift.machine.run': 'run-1'}, Containers: {'container-1': {}, 'sidecar-1': {}}};
  const want = {networkId: 'net-1', labels: {'sift.machine.run': 'run-1'}, containerIds: ['container-1', 'sidecar-1']};

  it('accepts our internal bridge holding exactly our containers', () => {
    expect(evaluateNetworkInspect(network, want)).toEqual([]);
    expect(networkCreateArgs('sift-run-1', {'sift.machine.run': 'run-1'}))
      .toEqual(['network', 'create', '--driver', 'bridge', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', 'sift.machine.run=run-1', 'sift-run-1']);
  });

  it('rejects an external, IPv6, host-addressed, foreign or crowded network', () => {
    expect(evaluateNetworkInspect({...network, Options: {}}, want)).toContain('network_gateway_not_isolated');
    expect(evaluateNetworkInspect({...network, Internal: false}, want)).toContain('network_not_internal');
    expect(evaluateNetworkInspect({...network, EnableIPv6: true}, want)).toContain('network_ipv6');
    expect(evaluateNetworkInspect({...network, Labels: {}}, want)).toContain('network_labels');
    expect(evaluateNetworkInspect({...network, Containers: {...network.Containers, stranger: {}}}, want)).toContain('network_members');
  });
});

describe('dockerVersionProblem', () => {
  it('requires Docker 28 for an isolated gateway', () => {
    expect(dockerVersionProblem({ServerVersion: '28.0.1'})).toBeNull();
    expect(dockerVersionProblem({ServerVersion: '29.1.0'})).toBeNull();
    expect(dockerVersionProblem({ServerVersion: '27.5.1'})).toBe('docker_28_required');
    expect(dockerVersionProblem({})).toBe('docker_28_required');
  });
});
