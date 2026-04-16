import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class OrganizationsUpdate extends BaseCommand {
  static description = 'Update an organization';

  static args = {
    id: Args.string({description: 'Organization ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Organization name'}),
    domain: Flags.string({description: 'Domain (e.g. acme.com)'}),
    industry: Flags.string({description: 'Industry'}),
    website: Flags.string({description: 'Website URL'}),
    'linkedin-url': Flags.string({description: 'LinkedIn page URL'}),
    notes: Flags.string({description: 'Notes'}),
    type: Flags.string({description: 'Organization type'}),
    location: Flags.string({description: 'Location'}),
    'relationship-status': Flags.string({description: 'Relationship status'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(OrganizationsUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.name !== undefined) updates.name = flags.name;
    if (flags.domain !== undefined) updates.domain = flags.domain;
    if (flags.industry !== undefined) updates.industry = flags.industry;
    if (flags.website !== undefined) updates.website = flags.website;
    if (flags['linkedin-url'] !== undefined) updates.linkedinUrl = flags['linkedin-url'];
    if (flags.notes !== undefined) updates.notes = flags.notes;
    if (flags.type !== undefined) updates.type = flags.type;
    if (flags.location !== undefined) updates.location = flags.location;
    if (flags['relationship-status'] !== undefined) updates.relationshipStatus = flags['relationship-status'];

    const response = await client.updateOrganization(args.id, updates, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Organization ${args.id} updated`);
    }

    return response.data;
  }
}
