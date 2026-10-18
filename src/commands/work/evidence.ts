import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

type PatchDisclosure = {
  sha256: string;
  bytes: number;
  fileCount: number;
  truncated: boolean;
  withheld: string | null;
  retainedSha256: string;
  retainedBytes: number;
  complete: boolean;
};

type AttemptEvidence = {
  version: 1;
  workItemId: string;
  attempt: {id: string; state: string; endReason: string | null; harness: string | null; model: string | null; host: string | null; startedAt: string; endedAt: string | null};
  result:
    | {status: 'recorded'; record: {recordedAt: string; payloadSha256: string}; patch: PatchDisclosure | null}
    | {status: 'pending'}
    | {status: 'missing'};
  decisions: {
    requests: Array<{kind: string; summary: string; state: string; resolution: {decision?: string} | null; resolvedAt: string | null; deliveryState: string}>;
    truncated: boolean;
  };
  verification: {boundToAttempt: false; attempts: Array<{outcome: string; attemptId: string; ranAt: string}>; truncated: boolean};
};

/** One line on how much of the diff the server holds; a cut or withheld patch is never shown as whole. */
export function describePatch(patch: PatchDisclosure): string {
  if (patch.complete) return `complete, ${patch.bytes} bytes, ${patch.fileCount} files, sha256 ${patch.sha256}`;
  const why = patch.withheld ? `withheld (${patch.withheld})` : patch.truncated ? 'cut to fit the 64 KiB result limit' : 'does not match the recorded hash';
  return `INCOMPLETE: ${why}. Retained ${patch.retainedBytes} of ${patch.bytes} bytes; whole diff sha256 ${patch.sha256}, retained ${patch.retainedSha256}`;
}

export default class WorkEvidence extends BaseCommand {
  static description = 'Show what the server retains about one execution attempt: result, patch, decisions and verification';

  static examples = ['<%= config.bin %> work evidence <work-item-id> --attempt <attempt-id> --json'];

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    attempt: Flags.string({description: 'Execution attempt ID', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkEvidence);
    const evidence = await this.apiRequest<AttemptEvidence>(
      flags,
      `/api/v1/work-items/${encodeURIComponent(args.id)}/execution-attempts/${encodeURIComponent(flags.attempt)}/evidence`,
    );
    if (!this.jsonEnabled()) {
      const {attempt, result, decisions, verification} = evidence;
      this.log(`Attempt ${attempt.id}: ${attempt.state}${attempt.endReason ? ` (${attempt.endReason})` : ''}`);
      this.log(`Agent ${attempt.harness ?? 'not reported'} · Model ${attempt.model ?? 'not reported'} · Host ${attempt.host ?? 'not reported'}`);
      this.log(`Started ${attempt.startedAt}${attempt.endedAt ? ` · Ended ${attempt.endedAt}` : ''}`);
      if (result.status === 'recorded') {
        this.log(`Result: recorded ${result.record.recordedAt}, sha256 ${result.record.payloadSha256}`);
        this.log(`Patch: ${result.patch ? describePatch(result.patch) : 'none in this result'}`);
      } else if (result.status === 'pending') {
        this.log('Result: pending; the attempt is still live and may record one.');
      } else {
        this.log('Result: MISSING. The attempt is no longer live and recorded no result; it cannot record one now.');
      }
      this.log(`Decisions: ${decisions.requests.length}${decisions.truncated ? ' (older ones not shown)' : ''}`);
      for (const request of decisions.requests) {
        const decision = request.resolution?.decision ?? (request.resolution ? 'answered' : request.state);
        this.log(`  ${request.kind} · ${request.summary} · ${decision}${request.resolvedAt ? ` at ${request.resolvedAt}` : ''} · delivery ${request.deliveryState}`);
      }
      this.log(`Verification (work item scope, not bound to this attempt): ${verification.attempts.length}${verification.truncated ? ' (older ones not shown)' : ''}`);
      for (const receipt of verification.attempts) this.log(`  ${receipt.outcome} · ${receipt.attemptId} · ${receipt.ranAt}`);
    }
    return evidence;
  }
}
