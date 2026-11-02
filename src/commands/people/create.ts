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
    context: Flags.string({
      description: 'How you know this person; repeat for both contexts',
      options: ['personal', 'work'],
      multiple: true,
    }),
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
    const contexts = flags.context as Array<'personal' | 'work'> | undefined;
    const contextRelationships = contexts?.map((context) => ({
      context,
      relationshipType: flags.relationship || (context === 'work' ? 'professional-contact' : 'contact'),
      isPrimary: true,
      basis: 'sift people create',
    }));

    const person = await this.apiRequest<Record<string, unknown>>(flags, '/api/v1/people', {
      method: 'POST',
      idempotencyKey: this.idempotencyKey(),
      body: {
        name: flags.name,
        email: flags.email,
        phone: flags.phone,
        company: flags.company,
        jobTitle: flags['job-title'],
        relationshipToUser: flags.relationship,
        contexts,
        contextRelationships,
        notes: flags.notes,
        linkedinUrl: flags['linkedin-url'],
        location: flags.location,
        website: flags.website,
        birthday: flags.birthday,
        birthYear: flags['birth-year'],
        estimatedAge: flags['estimated-age'],
        mbti: flags.mbti,
      },
    });

    if (!this.jsonEnabled()) {
      this.log(`Person created: ${person.id}`);
    }

    return person;
  }
}
