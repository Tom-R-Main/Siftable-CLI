import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class PeopleCreate extends BaseCommand {
  static description = 'Create a contact';

  static examples = [
    '<%= config.bin %> people create --name "Jane Doe"',
    '<%= config.bin %> people create --name "Jane Doe" --email jane@acme.com --company Acme --job-title "VP Eng"',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Full name', required: true}),
    email: Flags.string({description: 'Email address'}),
    phone: Flags.string({description: 'Phone number'}),
    company: Flags.string({description: 'Company name (auto-links to organization if exists)'}),
    'job-title': Flags.string({description: 'Job title'}),
    relationship: Flags.string({description: 'Relationship to user (e.g. friend, colleague, client, mentor)'}),
    notes: Flags.string({description: 'Notes about this person'}),
    'linkedin-url': Flags.string({description: 'LinkedIn profile URL'}),
    location: Flags.string({description: 'Location'}),
    website: Flags.string({description: 'Personal website'}),
    birthday: Flags.string({description: 'Birthday (YYYY-MM-DD)'}),
    'birth-year': Flags.integer({description: 'Birth year'}),
    'estimated-age': Flags.integer({description: 'Estimated age'}),
    mbti: Flags.string({description: 'MBTI type (e.g. INTJ, ENFP)'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(PeopleCreate);
    const client = await this.client(flags);

    const response = await client.createPerson(
      {
        name: flags.name,
        email: flags.email,
        phone: flags.phone,
        company: flags.company,
        jobTitle: flags['job-title'],
        relationshipToUser: flags.relationship,
        notes: flags.notes,
        linkedinUrl: flags['linkedin-url'],
        location: flags.location,
        website: flags.website,
        birthday: flags.birthday,
        birthYear: flags['birth-year'],
        estimatedAge: flags['estimated-age'],
        mbti: flags.mbti,
      },
      this.idempotencyKey(),
    );
    this.handleApiError(response);

    const person = this.unwrapOne(response, 'person');

    if (!this.jsonEnabled()) {
      this.log(`Person created: ${person.id}`);
    }

    return response.data;
  }
}
