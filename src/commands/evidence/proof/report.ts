import {Flags} from '@oclif/core';
import {readFileSync} from 'node:fs';
import {BaseCommand} from '../../../lib/base-command.js';
import {buildEvidenceProofReport, EvidencePacket, renderEvidenceProofMarkdown} from '../../../lib/evidence.js';

export default class EvidenceProofReport extends BaseCommand {
  static description = 'Generate an Evidence Graph proof report from a dataset-backed evidence packet';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Evidence Graph project ID for report metadata'}),
    'from-file': Flags.string({description: 'Evidence packet JSON file to report on', required: true}),
    format: Flags.string({description: 'Report format', options: ['json', 'markdown'], default: 'markdown'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EvidenceProofReport);
    const packet = readEvidencePacket(flags['from-file']);
    if (flags.project && !packet.project) {
      packet.project = {id: flags.project};
    }
    const report = buildEvidenceProofReport(packet);

    if (flags.format === 'markdown' && !this.jsonEnabled()) {
      this.log(renderEvidenceProofMarkdown(report));
      return report;
    }

    return report;
  }
}

function readEvidencePacket(path: string): EvidencePacket {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EvidencePacket;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Evidence packet must be a JSON object.');
  }
  return parsed;
}
