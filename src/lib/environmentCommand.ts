import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {assertDestinationSafeBeforeApproval, EnvironmentCheckoutSafetyError} from './environmentCheckoutSafety.js';
import {diffEnvExample} from './environmentExample.js';
import {parseEnvironmentManifest, type EnvironmentManifest} from './environmentManifest.js';
import {resolveManifestOwner} from './environmentOwner.js';
import {
  classifyEnvironmentMember,
  manifestFingerprint,
  readEnvironmentReceiptLedger,
  statEnvironmentDestination,
  type EnvironmentMemberState,
} from './environmentState.js';
import {resolveGitCheckout, type GitCheckoutContext} from './gitCheckoutContext.js';
import {evaluateGitIgnore, type IgnoreRule} from './gitIgnoreEvaluation.js';

export type EnvironmentFindingCode =
  | 'checkout_escape'
  | 'example_drift'
  | 'global_ignore_only'
  | 'manifest_absent'
  | 'manifest_invalid'
  | 'not_a_checkout'
  | 'owner_resolution'
  | 'tracked_destination'
  | 'unignored_destination';

export interface EnvironmentFinding {
  code: EnvironmentFindingCode;
  severity: 'error' | 'warning';
  destination?: string;
  message: string;
  ignore_rule?: IgnoreRule;
}

export interface EnvironmentMemberReport {
  name: string;
  destination: string;
  mode: '0400' | '0600';
  state: EnvironmentMemberState;
  owner?: string;
  authorization?: 'not_established';
}

export interface EnvironmentIgnoreReport {
  destination: string;
  strength: 'strong' | 'weak';
  rule: IgnoreRule;
}

export interface EnvironmentInspectionReport {
  schema_version: 1 | null;
  manifest: 'absent' | 'invalid' | 'valid';
  checkout: GitCheckoutContext['kind'];
  ok: boolean;
  findings: EnvironmentFinding[];
  members: EnvironmentMemberReport[];
  ignores: EnvironmentIgnoreReport[];
}

async function readOptionalText(filename: string): Promise<string | null> {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function memberReports(
  checkoutRoot: string,
  manifest: EnvironmentManifest,
  rawManifest: string,
): Promise<EnvironmentMemberReport[]> {
  const ledger = await readEnvironmentReceiptLedger(checkoutRoot);
  const fingerprint = manifestFingerprint(rawManifest);
  return Promise.all(manifest.members.map(async member => {
    const receipt = ledger?.receipts.find(candidate => candidate.name === member.name
      && candidate.destination === member.destination.path);
    const destination = await statEnvironmentDestination(path.join(checkoutRoot, member.destination.path));
    return {
      name: member.name,
      destination: member.destination.path,
      mode: member.destination.mode,
      state: classifyEnvironmentMember(receipt, destination, fingerprint),
      ...(member.kind === 'vault_field' ? (() => {
        const resolution = resolveManifestOwner(member.owner, manifest.owners);
        return resolution.ok ? {owner: resolution.owner, authorization: 'not_established' as const} : {};
      })() : {}),
    };
  }));
}

export async function inspectEnvironmentContract(
  checkoutRoot: string,
): Promise<EnvironmentInspectionReport> {
  const rawManifest = await readOptionalText(path.join(checkoutRoot, '.sift', 'environment.yaml'));
  const checkout = await resolveGitCheckout(checkoutRoot);
  const findings: EnvironmentFinding[] = [];
  const ignores: EnvironmentIgnoreReport[] = [];
  if (checkout.kind === 'not_a_repository' || checkout.kind === 'bare') {
    findings.push({
      code: 'not_a_checkout', severity: 'error',
      message: checkout.kind === 'bare' ? 'Bare repositories cannot host environment destinations.' : 'Directory is not a Git checkout.',
    });
  } else if (path.resolve(checkout.checkoutRoot) !== path.resolve(checkoutRoot)) {
    findings.push({code: 'checkout_escape', severity: 'error', message: 'Requested root is not the resolved checkout root.'});
  }
  if (rawManifest === null) {
    findings.push({code: 'manifest_absent', severity: 'error', message: '.sift/environment.yaml is absent.'});
    return {schema_version: null, manifest: 'absent', checkout: checkout.kind, ok: false, findings, members: [], ignores};
  }
  const parsed = parseEnvironmentManifest(rawManifest);
  if (!parsed.ok) {
    findings.push({
      code: 'manifest_invalid', severity: 'error',
      message: parsed.issues.map(item => `${item.path}: ${item.message}`).join('; '),
    });
    return {schema_version: null, manifest: 'invalid', checkout: checkout.kind, ok: false, findings, members: [], ignores};
  }

  const destinations = [...new Set(parsed.manifest.members.map(member => member.destination.path))].sort();
  for (const destination of destinations) {
    try {
      await assertDestinationSafeBeforeApproval(checkoutRoot, destination);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({
        code: 'checkout_escape', severity: 'error', destination,
        message: error instanceof EnvironmentCheckoutSafetyError ? `${error.code}: ${message}` : message,
      });
      continue;
    }
    if (checkout.kind === 'main_worktree' || checkout.kind === 'linked_worktree' || checkout.kind === 'submodule') {
      const ignore = await evaluateGitIgnore(checkoutRoot, destination);
      if (ignore.tracked) {
        findings.push({code: 'tracked_destination', severity: 'error', destination, message: 'Destination is tracked by Git.'});
      } else if (!ignore.covered) {
        findings.push({code: 'unignored_destination', severity: 'error', destination, message: 'Destination has no effective ignore rule.'});
      } else {
        ignores.push({destination, strength: ignore.strength, rule: ignore.rule});
        if (ignore.strength === 'weak') {
          findings.push({
            code: 'global_ignore_only', severity: 'warning', destination,
            message: ignore.remediation ?? 'Destination relies only on a global exclude.', ignore_rule: ignore.rule,
          });
        }
      }
    }
  }

  const example = diffEnvExample(parsed.manifest, await readOptionalText(path.join(checkoutRoot, '.env.example')));
  if (!example.current) {
    findings.push({
      code: 'example_drift', severity: 'error',
      message: example.reason === 'missing' ? '.env.example is missing.' : '.env.example differs from the contract.',
    });
  }
  const members = await memberReports(checkoutRoot, parsed.manifest, rawManifest);
  return {
    schema_version: 1,
    manifest: 'valid',
    checkout: checkout.kind,
    ok: !findings.some(finding => finding.severity === 'error'),
    findings,
    members,
    ignores,
  };
}

export async function loadEnvironmentManifest(checkoutRoot: string): Promise<EnvironmentManifest> {
  const rawManifest = await readOptionalText(path.join(checkoutRoot, '.sift', 'environment.yaml'));
  if (rawManifest === null) throw new Error('.sift/environment.yaml is absent. Author the contract first.');
  const parsed = parseEnvironmentManifest(rawManifest);
  if (!parsed.ok) throw new Error(parsed.issues.map(item => `${item.path}: ${item.message}`).join('; '));
  return parsed.manifest;
}
