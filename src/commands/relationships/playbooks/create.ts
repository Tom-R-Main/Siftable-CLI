import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import {readJsonObject} from '../../../lib/relationship-command-input.js';

export default class RelationshipPlaybooksCreate extends BaseCommand {
  static description = 'Create an immutable, unapproved relationship playbook version from runtime-contract JSON';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Playbook version JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm immutable version creation' }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipPlaybooksCreate);
    const input = readJsonObject(flags.file, 'playbook version');
    if (!await this.confirmAction('Create this immutable playbook version?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ playbook: Record<string, unknown> }>(
      flags, '/api/v1/relationship-playbooks/playbooks', { method: 'POST', body: input },
    );
    if (!this.jsonEnabled()) {
      const snapshot = response.playbook.snapshot as Record<string, unknown>;
      renderDetail([['ID', snapshot.playbookVersionId], ['Key', snapshot.stableKey], ['Version', snapshot.version], ['Approval', 'pending']]);
    }
    return response.playbook;
  }
}
