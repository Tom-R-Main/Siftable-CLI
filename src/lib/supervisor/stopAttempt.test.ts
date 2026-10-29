import {describe, expect, it} from 'vitest';
import {DEADLINE_EXIT, type DeadlineDocker} from './hostDocker.js';
import {STOP_BUDGET_MS, stopAttempt} from './stopAttempt.js';
import type {SupervisorClock} from './superviseAuthority.js';

const ATTEMPT = '5f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const owned = {attemptId: ATTEMPT, containers: ['a'.repeat(64), 'b'.repeat(64)], networkId: 'n'.repeat(64)};

function harness(options: {populated?: () => string; kill?: (id: string) => {code: number; stderr: string}; rm?: (id: string) => number} = {}) {
  let mono = 0;
  const clock: SupervisorClock = {wallMs: () => mono, monoMs: () => (mono += 5)};
  const calls: Array<{args: string[]; deadlineMono?: number}> = [];
  const docker: DeadlineDocker = async (args, call) => {
    calls.push({args, deadlineMono: call?.deadlineMono});
    if (args[1] === 'kill') return {code: 0, stdout: '', stderr: '', ...options.kill?.(args.at(-1)!)};
    if (args[1] === 'rm') return {code: options.rm?.(args.at(-1)!) ?? 0, stdout: '', stderr: ''};
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const readFile = async () => (options.populated ?? (() => 'populated 0\n'))();
  return {deps: {docker, clock, readFile, pollMs: 0}, calls};
}

describe('stopAttempt', () => {
  it('kills by exact ID under one deadline, proves the cgroup empty, then removes', async () => {
    const {deps, calls} = harness();
    const facts = await stopAttempt(deps, owned);
    expect(facts).toEqual({processesStopped: true, cgroupEmpty: 'empty', resourcesRemoved: true, held: []});
    const kills = calls.filter((call) => call.args[1] === 'kill');
    expect(kills.map((call) => call.args.at(-1))).toEqual(owned.containers);
    expect(new Set(kills.map((call) => call.deadlineMono)).size).toBe(1);
    expect(kills[0].deadlineMono).toBeLessThanOrEqual(5 + STOP_BUDGET_MS);
    expect(calls.filter((call) => call.args[1] === 'rm').map((call) => call.args.at(-1))).toEqual([...owned.containers, owned.networkId]);
  });

  it('removes nothing and holds everything while the cgroup stays populated', async () => {
    const {deps, calls} = harness({populated: () => 'populated 1\n'});
    const facts = await stopAttempt(deps, owned);
    expect(facts).toMatchObject({processesStopped: false, cgroupEmpty: 'populated', resourcesRemoved: false});
    expect(facts.held).toEqual([`cgroup:${ATTEMPT}`, ...owned.containers.map((id) => `container:${id}`), `network:${owned.networkId}`]);
    expect(calls.some((call) => call.args[1] === 'rm')).toBe(false);
  });

  it('treats an unreadable cgroup as unknown, never as stopped', async () => {
    const {deps} = harness({populated: () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); }});
    expect(await stopAttempt(deps, owned)).toMatchObject({processesStopped: false, cgroupEmpty: 'unknown'});
  });

  it('decides stopped from the cgroup, not a timed-out kill, and holds what it could not remove', async () => {
    const {deps} = harness({kill: (id) => (id === owned.containers[0] ? {code: DEADLINE_EXIT, stderr: ''} : {code: 0, stderr: ''}),
      rm: (id) => (id === owned.containers[1] ? 1 : 0)});
    const facts = await stopAttempt(deps, owned);
    expect(facts).toMatchObject({processesStopped: true, cgroupEmpty: 'empty', resourcesRemoved: false, held: [`container:${owned.containers[1]}`]});
  });

  it('kills known IDs before discovery, then extras, all under one deadline; an incomplete listing is held', async () => {
    const {deps, calls} = harness();
    let discoveredWith: number | undefined;
    const facts = await stopAttempt(deps, {...owned, networkId: undefined}, async (deadlineMono) => {
      discoveredWith = deadlineMono;
      expect(calls.filter((call) => call.args[1] === 'kill').map((call) => call.args.at(-1))).toEqual(owned.containers);
      return {containers: [owned.containers[0], 'c'.repeat(64)], networkIds: ['m'.repeat(64)], complete: false};
    });
    const kills = calls.filter((call) => call.args[1] === 'kill');
    expect(kills.map((call) => call.args.at(-1))).toEqual([...owned.containers, 'c'.repeat(64)]);
    expect(new Set([...kills.map((call) => call.deadlineMono), discoveredWith]).size).toBe(1);
    expect(facts).toMatchObject({cgroupEmpty: 'empty', resourcesRemoved: false, held: [`run:${ATTEMPT}`]});
    expect(calls.filter((call) => call.args[1] === 'rm').map((call) => call.args.at(-1))).toEqual([...owned.containers, 'c'.repeat(64), 'm'.repeat(64)]);
  });

  it('accepts containers that already exited or are gone', async () => {
    const {deps} = harness({kill: () => ({code: 1, stderr: 'Error response from daemon: Container abc is not running'})});
    expect(await stopAttempt(deps, owned)).toMatchObject({processesStopped: true, resourcesRemoved: true});
  });
});
