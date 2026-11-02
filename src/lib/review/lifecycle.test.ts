import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {once} from 'node:events';
import {afterEach, describe, expect, it} from 'vitest';
import {abortable, writeAtomicJson, type ReviewAttempt} from './lifecycle.js';
import {canonicalOutputPath, validateWorkspaceFlag} from '../../commands/review/index.js';
import {verifyReceipt} from './receipt.js';

const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, {recursive: true, force: true}); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'sift-review-lifecycle-')); owned.push(dir); return dir; }

describe('review lifecycle', () => {
  it('detects output aliases through symlinked parent directories', () => {
    const dir = temp(); mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    expect(canonicalOutputPath(join(dir, 'real', 'report.json'))).toBe(canonicalOutputPath(join(dir, 'alias', 'report.json')));
  });

  it('atomically replaces artifacts with private permissions', () => {
    const file = join(temp(), 'attempt.json');
    writeFileSync(file, 'stale clean', {mode: 0o644});
    writeAtomicJson(file, {status: 'failed'});
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({status: 'failed'});
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('never starts work after abort, and stops waiting for a hung stage', async () => {
    const controller = new AbortController();
    const pending = abortable(() => new Promise<never>(() => undefined), controller.signal);
    controller.abort(new Error('deadline exceeded'));
    await expect(pending).rejects.toThrow('deadline exceeded');
    let started = false;
    await expect(abortable(async () => { started = true; }, controller.signal)).rejects.toThrow('deadline exceeded');
    expect(started).toBe(false);
  });

  it.each(['/tmp/another-checkout', './checkout', '../checkout', 'C:\\checkout', '~/.repo'])('rejects a repository path passed as an organization: %s', value => {
    expect(() => validateWorkspaceFlag(value)).toThrow(/--repo/u);
  });
  it('accepts an organization identifier', () => expect(() => validateWorkspaceFlag('123e4567-e89b-12d3-a456-426614174000')).not.toThrow());

  it.each(['SIGINT', 'SIGTERM', 'deadline', 'setup'] as const)('persists a failed outcome and cleans up on %s', async mode => {
    const dir = temp();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {cwd: dir, encoding: 'utf8'}).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'example.ts'), 'export const n = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
    writeFileSync(join(dir, 'example.ts'), 'export const n = 2;\n'); git('commit', '-qam', 'head');
    const marker = join(dir, 'ready');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({status: 'clean', stale: true}));
    const source = resolve(__dirname, '../../commands/review/index.ts');
    const local = resolve(__dirname, 'localReview.ts');
    const runtime = resolve(__dirname, 'runtime.ts');
    const script = join(dir, 'child.cjs');
    writeFileSync(script, `const {writeFileSync}=require('node:fs');
const Review=require(${JSON.stringify(source)}).default;
const local=require(${JSON.stringify(local)});
const runtime=require(${JSON.stringify(runtime)}).loadTasterRuntime();
const root=${JSON.stringify(dir)};
runtime.review=async()=>{writeFileSync(${JSON.stringify(marker)},'ready');return new Promise(()=>{});};
const command=Object.create(Review.prototype);
command.parse=async()=>({flags:{repo:root,base:'main',model:'fixture','finder-passes':2,'max-model-calls':4,concurrency:1,'max-files':5,'deadline-ms':${mode === 'deadline' ? 1500 : 20000},receipt:${JSON.stringify(receipt)}}});
command.loadDeps=()=>({runtime,gitBin:'/usr/bin/git',path:local.childPath(['/usr/bin/git']),git:local.createGitExec({gitBin:'/usr/bin/git',path:local.childPath(['/usr/bin/git']),home:root}),modelSession:async()=>({models:{run:async()=>{throw new Error('unexpected model');}},close:async()=>{},problems:()=>[]})});
${mode === 'setup' ? "command.loadDeps=()=>{throw new local.LocalReviewSetupError('fixture setup unavailable');};" : ''}
command.jsonEnabled=()=>true;
command.run().catch(e=>{console.error(e);process.exitCode=2;});\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], {cwd: resolve(__dirname, '../../../..'), stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
    const exit = once(child, 'exit');
    try {
      const end = Date.now() + 15000;
      while (!existsSync(marker) && child.exitCode === null && Date.now() < end) await new Promise(resolveWait => setTimeout(resolveWait, 20));
      if (mode === 'SIGINT' || mode === 'SIGTERM') {
        expect(existsSync(marker), stderr).toBe(true);
        child.kill(mode);
      }
      const [code] = await Promise.race([exit, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`child timeout: ${stderr}`)), 15000).unref())]);
      expect(code, stderr).toBe(mode === 'SIGINT' ? 130 : mode === 'SIGTERM' ? 143 : 2);
      const attempt = JSON.parse(readFileSync(`${receipt}.attempt.json`, 'utf8')) as ReviewAttempt;
      expect(attempt.status).toBe(mode === 'deadline' ? 'timed_out' : mode === 'setup' ? 'failed' : 'interrupted');
      if (mode === 'setup') {
        expect(attempt.revision).toBeNull(); expect(attempt.receiptDigest).toBeNull();
        expect(existsSync(receipt)).toBe(false);
        return;
      }
      expect(attempt.revision?.head).toBe(git('rev-parse', 'HEAD'));
      const saved = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(saved.status).toBe('failed'); expect(verifyReceipt(saved)).toBe(true);
      expect(existsSync(`${receipt}.report.json`)).toBe(true);
    } finally { child.kill('SIGKILL'); }
  }, 25000);
});
