import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants as fsConstants, readFileSync} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {ExecutionGrantEnvelope} from './localExecutionRunner.js';
import {decryptExecutionGrantEnvelope} from './localExecutionRunner.js';

const execFileAsync = promisify(execFile);
const SAFE_MODES = new Map([['0400', 0o400], ['0600', 0o600]]);
const RISKY_SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|private[_-]?key|id_rsa|id_ed25519).*)/i;
const SAFE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export interface MaterializerRunner {
  publicKeyPem: string;
  privateKey: KeyObject | null;
  fingerprint: string;
  materializerDigest: string;
}

export interface DestinationPrecondition {
  expectedAbsence: boolean;
  expectedDestinationDigest?: string;
  trackedOrRisky: boolean;
  tracked: boolean;
  riskPolicyMatch: boolean;
}

export interface MaterializationReceipt {
  destinationPath: string;
  destinationDigest: string;
  mode: '0400' | '0600';
  writtenAt: string;
  cleanupSucceeded: boolean;
}

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function isInsideWorkspace(destinationPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, destinationPath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertNoSymlinkPath(
  targetPath: string,
  options: { requireDirectory?: boolean; requireOwner?: boolean } = {},
): Promise<void> {
  const parsed = path.parse(targetPath);
  const segments = targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Materialization path contains a symlink component: ${current}`);
    }
    if (current !== targetPath && !info.isDirectory()) {
      throw new Error(`Materialization parent is not a directory: ${current}`);
    }
    if (current === targetPath && options.requireDirectory && !info.isDirectory()) {
      throw new Error('Materialization workspace root is not a directory');
    }
    if (current === targetPath && options.requireOwner && info.uid !== process.getuid?.()) {
      throw new Error('Materialization path ownership is unsafe');
    }
  }
}

export async function validateMaterializationPath(input: {
  destinationPath: string;
  workspaceRoot: string;
}): Promise<{ destinationPath: string; workspaceRoot: string }> {
  if (!path.isAbsolute(input.destinationPath) || !path.isAbsolute(input.workspaceRoot)
    || path.normalize(input.destinationPath) !== input.destinationPath
    || path.normalize(input.workspaceRoot) !== input.workspaceRoot
    || !isInsideWorkspace(input.destinationPath, input.workspaceRoot)) {
    throw new Error('Materialization destination must be normalized and inside the workspace');
  }
  await assertNoSymlinkPath(input.workspaceRoot, {requireDirectory: true, requireOwner: true});
  const realWorkspace = await realpath(input.workspaceRoot);
  if (realWorkspace !== input.workspaceRoot) {
    throw new Error('Materialization workspace root resolves through a symlink');
  }
  await assertNoSymlinkPath(path.dirname(input.destinationPath), {
    requireDirectory: true,
    requireOwner: true,
  });
  try {
    const destination = await lstat(input.destinationPath);
    if (destination.isSymbolicLink() || !destination.isFile()) {
      throw new Error('Materialization destination is a symlink or special file');
    }
    if (destination.uid !== process.getuid?.()) {
      throw new Error('Materialization destination ownership is unsafe');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return input;
}

async function gitPathPolicy(
  workspaceRoot: string,
  destinationPath: string,
): Promise<{tracked: boolean; riskPolicyMatch: boolean}> {
  const relative = path.relative(workspaceRoot, destinationPath);
  let tracked = false;
  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'ls-files', '--error-unmatch', '--', relative], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    tracked = true;
  } catch {
    tracked = false;
  }
  return {tracked, riskPolicyMatch: RISKY_SECRET_PATH.test(relative)};
}

export async function inspectMaterializationDestination(input: {
  destinationPath: string;
  workspaceRoot: string;
  trackedFileException: boolean;
  policyAllowsTrackedException: boolean;
}): Promise<DestinationPrecondition> {
  await validateMaterializationPath(input);
  const gitPolicy = await gitPathPolicy(input.workspaceRoot, input.destinationPath);
  if ((gitPolicy.tracked || gitPolicy.riskPolicyMatch)
    && (!input.trackedFileException || !input.policyAllowsTrackedException)) {
    throw new Error('Destination is tracked by Git or matches secret-risk policy');
  }
  try {
    const handle = await open(input.destinationPath, SAFE_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.()) {
        throw new Error('Existing materialization destination is unsafe');
      }
      const digest = createHash('sha256').update(await handle.readFile()).digest('hex');
      return {
        expectedAbsence: false,
        expectedDestinationDigest: digest,
        trackedOrRisky: gitPolicy.tracked || gitPolicy.riskPolicyMatch,
        ...gitPolicy,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      expectedAbsence: true,
      trackedOrRisky: gitPolicy.tracked || gitPolicy.riskPolicyMatch,
      ...gitPolicy,
    };
  }
}

export function createMaterializerRunner(): MaterializerRunner {
  const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
  const publicKeyPem = pair.publicKey.export({type: 'spki', format: 'pem'}).toString();
  const materializerDigest = createHash('sha256')
    .update(readFileSync(__filename))
    .update(process.version)
    .digest('hex');
  return {
    publicKeyPem,
    privateKey: pair.privateKey,
    fingerprint: createHash('sha256').update(publicKeyPem.trim()).digest('hex'),
    materializerDigest,
  };
}

export function createMaterializationArtifactBinding(input: {
  materializationId: string;
  runnerFingerprint: string;
  materializerDigest: string;
  nonce: string;
}): string {
  return canonicalJson(input);
}

export function createMaterializationCredentialBinding(input: {
  materializationId: string;
  sourceEntry: string;
  sourceField: string;
  runnerFingerprint: string;
  materializerDigest: string;
  destinationPath: string;
  workspaceRoot: string;
  mode: '0400' | '0600';
  expectedAbsence: boolean;
  expectedDestinationDigest?: string;
  trackedFileException: boolean;
  purpose: string;
  nonce: string;
}): string {
  return canonicalJson({
    materializationId: input.materializationId,
    sourceEntry: input.sourceEntry,
    sourceField: input.sourceField,
    runnerFingerprint: input.runnerFingerprint,
    materializerDigest: input.materializerDigest,
    destinationPath: input.destinationPath,
    workspaceRoot: input.workspaceRoot,
    mode: input.mode,
    expectedDigest: input.expectedDestinationDigest ?? 'none',
    expectedAbsence: String(input.expectedAbsence),
    trackedFileException: String(input.trackedFileException),
    purposeDigest: createHash('sha256').update(input.purpose).digest('hex'),
    nonce: input.nonce,
  });
}

export function decryptMaterializationEnvelope(
  envelope: ExecutionGrantEnvelope,
  privateKey: KeyObject,
  binding: string,
  expectedKind: 'vault_materialization_artifact' | 'vault_materialization_plaintext',
  field: 'artifact' | 'value',
): string {
  const decrypted = decryptExecutionGrantEnvelope(envelope, privateKey, binding);
  if (decrypted.kind !== expectedKind || !decrypted.fields[field]) {
    throw new Error('Materialization envelope is invalid');
  }
  const value = decrypted.fields[field];
  decrypted.fields[field] = '';
  return value;
}

async function verifyPrecondition(input: {
  destinationPath: string;
  expectedAbsence: boolean;
  expectedDestinationDigest?: string;
}): Promise<void> {
  try {
    const handle = await open(input.destinationPath, SAFE_READ_FLAGS);
    try {
      if (input.expectedAbsence) {
        throw new Error('Destination appeared after approval');
      }
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.()) {
        throw new Error('Destination changed to an unsafe file');
      }
      const observed = createHash('sha256').update(await handle.readFile()).digest('hex');
      if (observed !== input.expectedDestinationDigest) {
        throw new Error('Destination digest changed after approval');
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && input.expectedAbsence) return;
    throw error;
  }
}

export async function materializeApprovedPlaintext(input: {
  plaintext: string;
  destinationPath: string;
  workspaceRoot: string;
  mode: '0400' | '0600';
  expectedAbsence: boolean;
  expectedDestinationDigest?: string;
  trackedFileException: boolean;
  policyAllowsTrackedException: boolean;
  beforeCommit?: () => Promise<void>;
  onCommitted?: () => void;
  onCleanup?: (succeeded: boolean) => void;
}): Promise<MaterializationReceipt> {
  const requestedMode = SAFE_MODES.get(input.mode);
  if (!requestedMode) throw new Error('Unsupported materialization mode');
  await validateMaterializationPath(input);
  const policy = await gitPathPolicy(input.workspaceRoot, input.destinationPath);
  if ((policy.tracked || policy.riskPolicyMatch)
    && (!input.trackedFileException || !input.policyAllowsTrackedException)) {
    throw new Error('Destination is tracked by Git or matches secret-risk policy');
  }
  await verifyPrecondition(input);
  const parent = path.dirname(input.destinationPath);
  const tempDir = await mkdtemp(path.join(parent, '.sift-materialize-'));
  const tempPath = path.join(tempDir, `payload-${randomBytes(8).toString('hex')}`);
  const bytes = Buffer.from(input.plaintext, 'utf8');
  let cleanupSucceeded = false;
  let receipt: Omit<MaterializationReceipt, 'cleanupSucceeded'> | undefined;
  try {
    const temp = await open(tempPath, 'wx', 0o600);
    try {
      await temp.writeFile(bytes);
      await temp.sync();
      await chmod(tempPath, requestedMode);
    } finally {
      await temp.close();
    }
    await input.beforeCommit?.();
    await validateMaterializationPath(input);
    await verifyPrecondition(input);
    if (input.expectedAbsence) {
      await link(tempPath, input.destinationPath);
      input.onCommitted?.();
      await unlink(tempPath);
    } else {
      await rename(tempPath, input.destinationPath);
      input.onCommitted?.();
    }
    const directory = await open(parent, 'r');
    try {
      try {
        await directory.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
      }
    } finally {
      await directory.close();
    }
    const finalInfo = await stat(input.destinationPath);
    if ((finalInfo.mode & 0o777) !== requestedMode || !finalInfo.isFile()) {
      throw new Error('Materialization permission verification failed');
    }
    const destinationDigest = createHash('sha256').update(bytes).digest('hex');
    receipt = {
      destinationPath: input.destinationPath,
      destinationDigest,
      mode: input.mode,
      writtenAt: new Date().toISOString(),
    };
  } finally {
    bytes.fill(0);
    try {
      await rm(tempDir, {recursive: true, force: true});
      cleanupSucceeded = true;
    } finally {
      input.onCleanup?.(cleanupSucceeded);
    }
  }
  return {...receipt!, cleanupSucceeded};
}
