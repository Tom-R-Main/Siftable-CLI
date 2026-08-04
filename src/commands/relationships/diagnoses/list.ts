import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';
import {queryString} from '../../../lib/relationship-command-input.js';

export default class RelationshipDiagnosesList extends BaseCommand {
  static description = 'List immutable relationship diagnosis snapshots';
  static flags = {
    ...BaseCommand.baseFlags,
    'subject-type': Flags.string({ options: ['prospect', 'opportunity'] }),
    'subject-id': Flags.string(),
    limit: Flags.integer({ min: 1, max: 200 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipDiagnosesList);
    if (Boolean(flags['subject-type']) !== Boolean(flags['subject-id'])) this.error('--subject-type and --subject-id must be provided together');
    const response = await this.apiRequest<{ diagnoses: Array<Record<string, unknown>> }>(
      flags,
      `/api/v1/relationship-playbooks/diagnoses${queryString({ subjectType: flags['subject-type'], subjectId: flags['subject-id'], limit: flags.limit })}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.diagnoses.map((diagnosis) => ({
        id: diagnosis.diagnosisId,
        subject: `${(diagnosis.subject as Record<string, unknown>).kind}:${(diagnosis.subject as Record<string, unknown>).id}`,
        review: diagnosis.reviewState,
        missing: Array.isArray(diagnosis.missingInformation) ? diagnosis.missingInformation.length : 0,
      })), [
        { key: 'id', header: 'Diagnosis' },
        { key: 'subject', header: 'Subject' },
        { key: 'review', header: 'Review' },
        { key: 'missing', header: 'Missing' },
      ]);
    }
    return response.diagnoses;
  }
}
