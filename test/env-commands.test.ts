import {execFileSync, spawnSync} from 'node:child_process';
import {chmod, mkdtemp, mkdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import EnvStatus from '../src/commands/env/status.js';
import EnvDiff from '../src/commands/env/diff.js';
import EnvCheck from '../src/commands/env/check.js';
import EnvExample from '../src/commands/env/example.js';
import {inspectEnvironmentContract} from '../src/lib/environmentCommand.js';
import {renderEnvExample} from '../src/lib/environmentExample.js';
import {parseEnvironmentManifest} from '../src/lib/environmentManifest.js';
import {
  manifestFingerprint,
  statEnvironmentDestination,
  writeEnvironmentReceiptLedger,
  type EnvironmentMemberState,
} from '../src/lib/environmentState.js';
import * as environmentState from '../src/lib/environmentState.js';
import {runCommand} from './helpers/mock-api.js';

const roots: string[] = [];
const repositoryRoot = path.resolve(process.cwd(), '../..');
let isolatedGitConfigHome: string | undefined;

beforeAll(async () => {
  isolatedGitConfigHome = await mkdtemp(path.join(tmpdir(), 'sift-env-git-config-'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('XDG_CONFIG_HOME', isolatedGitConfigHome);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (isolatedGitConfigHome) await rm(isolatedGitConfigHome, {recursive: true, force: true});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

const manifest = `
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: TOKEN
    kind: vault_field
    owner: personal
    entry_id: 22222222-2222-4222-8222-222222222222
    field: token
    sensitivity: secret
    destination: {path: .runtime/service.env, mode: "0600"}
`;

async function checkout(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sift-env-command-')));
  roots.push(root);
  await mkdir(path.join(root, '.sift'));
  await writeFile(path.join(root, '.sift', 'environment.yaml'), manifest);
  return root;
}

async function writeCurrentExample(root: string, rawManifest = manifest): Promise<void> {
  const parsed = parseEnvironmentManifest(rawManifest);
  if (!parsed.ok) throw new Error('test manifest did not parse');
  await writeFile(path.join(root, '.env.example'), renderEnvExample(parsed.manifest));
}

async function gitCheckout(ignore = ''): Promise<string> {
  const root = await checkout();
  execFileSync('git', ['init', '-q'], {cwd: root});
  if (ignore) await writeFile(path.join(root, '.gitignore'), ignore);
  return root;
}

async function statusCheckout(state: EnvironmentMemberState): Promise<string> {
  const root = await gitCheckout('.runtime/\n');
  await writeCurrentExample(root);
  if (state === 'absent') return root;

  const destination = path.join(root, '.runtime', 'service.env');
  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, 'must-not-leak', {mode: 0o600});
  if (state === 'unmanaged') return root;

  const destinationStat = await statEnvironmentDestination(destination);
  if (!destinationStat.exists) throw new Error('test destination was not created');
  await writeEnvironmentReceiptLedger(root, {
    schema_version: 1,
    receipts: [{
      name: 'TOKEN',
      destination: '.runtime/service.env',
      mode: '0600',
      ...(state === 'managed_unknown_freshness'
        ? {}
        : {manifest_fingerprint: state === 'managed_stale' ? '0'.repeat(64) : manifestFingerprint(manifest)}),
      materialized_at: '2026-08-04T00:00:00.000Z',
      stat: {
        device: destinationStat.device,
        inode: destinationStat.inode,
        mode: destinationStat.mode,
        mtime_ms: destinationStat.mtime_ms,
        ctime_ms: destinationStat.ctime_ms,
      },
    }],
  });
  if (state === 'modified_locally') await chmod(destination, 0o400);
  return root;
}

describe('offline env commands', () => {
  it('reports manifest/example drift, non-Git and unignored findings without network access', async () => {
    const root = await checkout();
    const fetch = vi.fn(() => { throw new Error('network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    const report = await inspectEnvironmentContract(root);
    expect(report.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'not_a_checkout', 'example_drift',
    ]));
    expect(JSON.stringify(report)).not.toContain('must-not-leak');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an unsafe member visible without inspecting destination metadata', async () => {
    const root = await checkout();
    await writeFile(path.join(root, '.sift', 'environment.yaml'), manifest.replace('.runtime/service.env', '../outside'));
    const destinationStat = vi.spyOn(environmentState, 'statEnvironmentDestination');
    const report = await inspectEnvironmentContract(root);
    expect(report.ok).toBe(false);
    expect(report.findings.map(finding => finding.code)).toContain('checkout_escape');
    expect(report.members).toEqual([
      expect.objectContaining({name: 'TOKEN', destination: '../outside', state: 'unmanaged'}),
    ]);
    expect(destinationStat).not.toHaveBeenCalled();

    const safeRoot = await gitCheckout('.runtime/\n');
    await writeCurrentExample(safeRoot);
    await inspectEnvironmentContract(safeRoot);
    expect(destinationStat).toHaveBeenCalledWith(path.join(safeRoot, '.runtime', 'service.env'));
  });

  it('fails on tracked and unignored destinations without changing the index', async () => {
    const trackedRoot = await checkout();
    execFileSync('git', ['init', '-q'], {cwd: trackedRoot});
    await mkdir(path.join(trackedRoot, '.runtime'));
    await writeFile(path.join(trackedRoot, '.runtime', 'service.env'), 'placeholder');
    execFileSync('git', ['add', '-f', '.runtime/service.env'], {cwd: trackedRoot});
    const indexPath = path.join(trackedRoot, '.git', 'index');
    const before = (await stat(indexPath)).mtimeNs;
    expect((await inspectEnvironmentContract(trackedRoot)).findings.map(finding => finding.code))
      .toContain('tracked_destination');
    expect((await stat(indexPath)).mtimeNs).toBe(before);

    const unignoredRoot = await checkout();
    execFileSync('git', ['init', '-q'], {cwd: unignoredRoot});
    expect((await inspectEnvironmentContract(unignoredRoot)).findings.map(finding => finding.code))
      .toContain('unignored_destination');
  });

  it('keeps flags offline and teaches the contract-first flow', () => {
    for (const command of [EnvStatus, EnvDiff, EnvCheck, EnvExample]) {
      expect(Object.keys(command.flags)).not.toEqual(expect.arrayContaining(['token', 'api-url']));
      const prose = `${command.description ?? ''} ${(command as {summary?: string}).summary ?? ''}`;
      expect(prose).not.toMatch(/vault read|auth.file|commit.*ciphertext|secret.*stdout/i);
    }
    expect(`${EnvCheck.description} ${EnvExample.description}`).toMatch(/\.sift\/environment\.yaml/);
    expect(EnvCheck.description).toMatch(/contract/i);
  });

  it('discovers exactly the four supported env commands through the real CLI help boundary', () => {
    const result = spawnSync(process.execPath, ['packages/exf-cli/bin/run.js', 'env', '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('env status');
    expect(result.stdout).toContain('env diff');
    expect(result.stdout).toContain('env check');
    expect(result.stdout).toContain('env example');
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/env(?::| )offline-command/);

    const removed = spawnSync(process.execPath, ['packages/exf-cli/bin/run.js', 'env', 'offline-command', '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(removed.status).not.toBe(0);
    expect(`${removed.stdout}\n${removed.stderr}`).toMatch(/not found|nonexistent/i);
  });

  it('keeps env example JSON output machine-parseable without dotenv preview text', async () => {
    const root = await checkout();
    const result = await runCommand(['env', 'example', '--checkout-root', root, '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({written: false, path: null});
    expect(result.stdout).not.toContain('TOKEN=');
  });

  it.each([
    ['example drift', async () => gitCheckout('.runtime/\n')],
    ['tracked destination', async () => {
      const root = await gitCheckout();
      await mkdir(path.join(root, '.runtime'));
      await writeFile(path.join(root, '.runtime', 'service.env'), 'must-not-leak');
      execFileSync('git', ['add', '-f', '.runtime/service.env'], {cwd: root});
      await writeCurrentExample(root);
      return root;
    }],
    ['unignored destination', async () => {
      const root = await gitCheckout();
      await writeCurrentExample(root);
      return root;
    }],
    ['checkout escape', async () => {
      const root = await gitCheckout();
      const escaping = manifest.replace('.runtime/service.env', '../outside');
      await writeFile(path.join(root, '.sift', 'environment.yaml'), escaping);
      await writeCurrentExample(root, escaping);
      return root;
    }],
  ])('fails both command boundaries with value-free output for %s', async (_label, makeRoot) => {
    for (const argv of [['env', 'diff'], ['env', 'check', '--ci']]) {
      const root = await makeRoot();
      const result = await runCommand([...argv, '--checkout-root', root]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain('must-not-leak');
    }
  });

  it('reports strong winning ignore provenance at the command and report boundary', async () => {
    const root = await gitCheckout('.runtime/\n');
    await writeCurrentExample(root);
    const report = await inspectEnvironmentContract(root);
    expect(report.ignores).toEqual([
      expect.objectContaining({
        destination: '.runtime/service.env',
        strength: 'strong',
        rule: expect.objectContaining({pattern: '.runtime/', source: path.join(root, '.gitignore'), line: 1}),
      }),
    ]);
    const command = await runCommand(['env', 'status', '--checkout-root', root]);
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain('IGNORE strong .runtime/service.env');
    expect(command.stdout).toContain(path.join(root, '.gitignore'));
    expect(command.stdout).toContain('line=1');
  });

  it.each<EnvironmentMemberState>([
    'absent',
    'managed_current',
    'managed_stale',
    'modified_locally',
    'unmanaged',
    'managed_unknown_freshness',
  ])('reports %s through the real status command boundary', async state => {
    const root = await statusCheckout(state);
    const command = await runCommand(['env', 'status', '--checkout-root', root]);
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain(`TOKEN\t${state}\t.runtime/service.env\t0600`);
    expect(command.stdout).not.toContain('must-not-leak');
  });
});
