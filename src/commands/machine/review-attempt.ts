import {Command, Flags} from '@oclif/core';
import {tmpdir} from 'node:os';
import {childPath, createGitExec, findOnPath} from '../../lib/review/localReview.js';
import {type MachineReviewRequest, REVIEW_RESULT_VERSION, runMachineReview} from '../../lib/review/machineReview.js';
import {loadTasterRuntime} from '../../lib/review/runtime.js';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Runs inside the reviewer container the supervisor starts in its review phase (first-run U3-2): reads the request
 * from SIFT_REVIEW and the relay route from SIFT_RELAY_URL, reviews the verified tree mounted at /verify, and prints
 * one result line. It holds no credential and reaches nothing but the relay.
 */
export default class MachineReviewAttempt extends Command {
  static hidden = true;
  static description = 'Review an attempt\'s verified result inside the reviewer container (started by the supervisor)';
  static flags = {
    // Whoever pins the reviewer image reads the server's MACHINE_REVIEWER_POLICY_REVISION from here (skill-pin-v1.md).
    'policy-revision': Flags.boolean({description: 'Print the revision of the policy pack this CLI bundles, and exit'}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(MachineReviewAttempt);
    if (flags['policy-revision']) {
      process.stdout.write(`${loadTasterRuntime().loadDefaultPolicyBundle().revisionId}\n`);
      return;
    }
    const print = (result: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(result)}\n`);
    let request: MachineReviewRequest;
    try {
      request = JSON.parse(process.env.SIFT_REVIEW ?? '') as MachineReviewRequest;
    } catch {
      request = {} as MachineReviewRequest;
    }
    const relay = process.env.SIFT_RELAY_URL ?? '';
    const policyOk = request.policyRevision === undefined || /^sha256:[0-9a-f]{64}$/.test(String(request.policyRevision));
    if (!SHA.test(request.baseSha ?? '') || !SHA.test(request.head ?? '') || typeof request.model !== 'string' || !policyOk
      || !/^http:\/\/[a-z0-9.-]+:\d+\//.test(relay)) {
      print({version: REVIEW_RESULT_VERSION, ok: false, code: 'review_request_invalid', detail: 'SIFT_REVIEW or SIFT_RELAY_URL is malformed'});
      process.exitCode = 2;
      return;
    }
    const gitBin = findOnPath('git') ?? '/usr/bin/git';
    const codexBin = findOnPath('codex');
    if (!codexBin) {
      print({version: REVIEW_RESULT_VERSION, ok: false, code: 'review_failed', detail: 'codex is not installed in the reviewer image'});
      process.exitCode = 2;
      return;
    }
    const path = childPath([gitBin, codexBin]);
    const result = await runMachineReview(request, {runtime: loadTasterRuntime(), git: createGitExec({gitBin, path, home: tmpdir()}),
      gitBin, codexBin, path, relayResponsesUrl: relay});
    print(result);
    process.exitCode = result.ok === true ? 0 : 2;
  }
}
