import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../playbooks/_helpers.js';

export default class RelationshipDiagnosesCreate extends BaseCommand {
  static description = 'Create an immutable, evidence-grounded relationship diagnosis snapshot';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Diagnosis JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm immutable diagnosis creation' }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipDiagnosesCreate);
    const input = readJsonObject(flags.file, 'diagnosis');
    if (!await this.confirmAction('Create this immutable relationship diagnosis?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ diagnosis: Record<string, unknown> }>(
      flags, '/api/v1/relationship-playbooks/diagnoses', { method: 'POST', body: input },
    );
    if (!this.jsonEnabled()) renderDetail([['Diagnosis', response.diagnosis.diagnosisId], ['Review', response.diagnosis.reviewState]]);
    return response.diagnosis;
  }
}
