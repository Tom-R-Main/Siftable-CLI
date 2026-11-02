import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default class RelationshipOutcomesInspect extends BaseCommand {
  static description = 'Inspect declared relationship outcomes in Answer/C0 mode without persistence';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact InspectRelationshipOutcomeInput JSON'}),
    'input-file': Flags.string({description: 'Path to exact inspection input JSON'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipOutcomesInspect);
    const input = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (!isObject(input)) this.error('Provide --input or --input-file containing a JSON object.');
    const declaration = input.declaration;
    if (!isObject(declaration) || declaration.taskMode !== 'answer' || declaration.commitmentClass !== 'C0') {
      this.error('Inspection requires an explicit Answer/C0 declaration.');
    }
    const response = await this.apiRequest<{snapshot: Record<string, unknown>}>(flags, `${OUTCOMES_API}/inspect`, {
      method: 'POST',
      body: input,
    });
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Snapshot', response.snapshot?.snapshotId ?? 'preview'],
        ['Projection', response.snapshot?.projection ?? input.projection ?? '—'],
        ['Commitment', 'C0; no persistence or action execution'],
      ]);
    }
    return response;
  }
}
