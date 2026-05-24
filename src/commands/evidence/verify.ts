import {Flags} from '@oclif/core';
import {readFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {EvidencePacket, verifyEvidencePacket} from '../../lib/evidence.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class EvidenceVerify extends BaseCommand {
  static description = 'Verify Evidence Graph provenance, review, projection, and citation invariants';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Evidence Graph project ID for report metadata'}),
    'from-file': Flags.string({description: 'Evidence packet JSON file to verify', required: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EvidenceVerify);
    const packet = readEvidencePacket(flags['from-file']);
    if (flags.project && !packet.project) {
      packet.project = {id: flags.project};
    }
    const verification = verifyEvidencePacket(packet);
    const result = {
      ok: verification.ok,
      projectId: flags.project ?? packet.project?.id,
      verification,
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Status', verification.ok ? 'pass' : 'fail'],
        ['Errors', verification.findings.filter((finding) => finding.severity === 'error').length],
        ['Warnings', verification.findings.filter((finding) => finding.severity === 'warning').length],
      ]);
      if (verification.findings.length > 0) {
        this.log('');
        renderTable(verification.findings as unknown as Record<string, unknown>[], [
          {key: 'severity', header: 'Severity'},
          {key: 'code', header: 'Code'},
          {key: 'ref', header: 'Ref'},
          {key: 'message', header: 'Message'},
        ]);
      }
    }

    return result;
  }
}

function readEvidencePacket(path: string): EvidencePacket {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EvidencePacket;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Evidence packet must be a JSON object.');
  }
  return parsed;
}
