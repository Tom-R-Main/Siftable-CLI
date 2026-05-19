import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class PeopleRelate extends BaseCommand {
  static description = 'Create or update a relationship between two people';

  static args = {
    personAId: Args.string({description: 'First person ID', required: true}),
    personBId: Args.string({description: 'Second person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    type: Flags.string({description: 'Relationship type, e.g. colleague, sibling, spouse, collaborator', required: true}),
    notes: Flags.string({description: 'Relationship notes'}),
    'dry-run': Flags.boolean({description: 'Preview the relationship payload without writing'}),
    yes: Flags.boolean({char: 'y', description: 'Apply without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleRelate);
    const payload = {
      personBId: args.personBId,
      relationshipType: flags.type,
      notes: flags.notes,
    };

    if (flags['dry-run']) {
      const result = {
        ok: true,
        dryRun: true,
        personAId: args.personAId,
        relationship: payload,
        summary: {createOrUpdate: 1},
        warnings: [],
      };
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Dry run', 'yes'],
          ['Person A', args.personAId],
          ['Person B', args.personBId],
          ['Type', flags.type],
          ['Notes', flags.notes],
        ]);
      }
      return result;
    }

    if (!flags.yes && flags['no-input']) {
      this.error('Refusing to create relationship without --yes when --no-input is set. Re-run with --dry-run or --yes.');
    }

    if (!flags.yes) {
      const {confirm} = await import('../../lib/output.js');
      const ok = await confirm(`Create ${flags.type} relationship between ${args.personAId} and ${args.personBId}?`);
      if (!ok) {
        this.error('Aborted.');
      }
    }

    const client = await this.client(flags);
    const response = await client.createPersonRelationship(args.personAId, payload);
    this.handleApiError(response);
    const relationship = response.data as Record<string, unknown>;
    const result = {
      ok: true,
      dryRun: false,
      relationship,
      summary: {createOrUpdate: 1},
      warnings: [],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', relationship.id],
        ['Person A', relationship.personAId],
        ['Person B', relationship.personBId],
        ['Type', relationship.relationshipType],
        ['Notes', relationship.notes],
      ]);
    }

    return result;
  }
}
