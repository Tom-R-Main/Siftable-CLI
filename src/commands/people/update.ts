import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class PeopleUpdate extends BaseCommand {
  static description = 'Update a contact';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Full name'}),
    email: Flags.string({description: 'Email address'}),
    phone: Flags.string({description: 'Phone number'}),
    company: Flags.string({description: 'Company name'}),
    'job-title': Flags.string({description: 'Job title'}),
    relationship: Flags.string({description: 'Relationship to user'}),
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
    const {args, flags} = await this.parse(PeopleUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.name !== undefined) updates.name = flags.name;
    if (flags.email !== undefined) updates.email = flags.email;
    if (flags.phone !== undefined) updates.phone = flags.phone;
    if (flags.company !== undefined) updates.company = flags.company;
    if (flags['job-title'] !== undefined) updates.jobTitle = flags['job-title'];
    if (flags.relationship !== undefined) updates.relationshipToUser = flags.relationship;
    if (flags.notes !== undefined) updates.notes = flags.notes;
    if (flags['linkedin-url'] !== undefined) updates.linkedinUrl = flags['linkedin-url'];
    if (flags.location !== undefined) updates.location = flags.location;
    if (flags.website !== undefined) updates.website = flags.website;
    if (flags.birthday !== undefined) updates.birthday = flags.birthday;
    if (flags['birth-year'] !== undefined) updates.birthYear = flags['birth-year'];
    if (flags['estimated-age'] !== undefined) updates.estimatedAge = flags['estimated-age'];
    if (flags.mbti !== undefined) updates.mbti = flags.mbti;

    const response = await client.updatePerson(args.id, updates, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Person ${args.id} updated`);
    }

    return response.data;
  }
}
