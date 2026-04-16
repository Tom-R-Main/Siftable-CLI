import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class OrganizationsCreate extends BaseCommand {
  static description = 'Create an organization';

  static examples = [
    '<%= config.bin %> organizations create --name "Acme Corp"',
    '<%= config.bin %> organizations create --name "Acme Corp" --domain acme.com --industry "Software" --type company',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Organization name', required: true}),
    domain: Flags.string({description: 'Domain (e.g. acme.com)'}),
    industry: Flags.string({description: 'Industry'}),
    website: Flags.string({description: 'Website URL'}),
    'linkedin-url': Flags.string({description: 'LinkedIn page URL'}),
    notes: Flags.string({description: 'Notes'}),
    type: Flags.string({description: 'Organization type (e.g. company, nonprofit, government, school)'}),
    location: Flags.string({description: 'Location'}),
    'relationship-status': Flags.string({description: 'Relationship status (e.g. prospect, customer, partner, vendor)'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(OrganizationsCreate);
    const client = await this.client(flags);

    const response = await client.createOrganization(
      {
        name: flags.name,
        domain: flags.domain,
        industry: flags.industry,
        website: flags.website,
        linkedinUrl: flags['linkedin-url'],
        notes: flags.notes,
        type: flags.type,
        location: flags.location,
        relationshipStatus: flags['relationship-status'],
      },
      this.idempotencyKey(),
    );
    this.handleApiError(response);

    const org = this.unwrapOne(response, 'organization');

    if (!this.jsonEnabled()) {
      this.log(`Organization created: ${org.id}`);
    }

    return response.data;
  }
}
