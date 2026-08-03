import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

export default class RelationshipOutcomesDescribe extends BaseCommand {
  static description = 'Describe the runtime relationship-outcome contracts and safety boundaries';

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipOutcomesDescribe);
    const response = await this.apiRequest<{definitions: Record<string, unknown>}>(
      flags,
      `${OUTCOMES_API}/definitions`,
    );
    if (!this.jsonEnabled()) {
      const definitions = response.definitions ?? {};
      const task = definitions.task as Record<string, unknown> | undefined;
      const learning = definitions.learning as Record<string, unknown> | undefined;
      renderDetail([
        ['Contract version', definitions.contractVersion ?? definitions.version ?? '—'],
        ['Safe default', task?.safeDefault ?? definitions.safeDefault ?? 'no_mutation'],
        ['Learning', learning?.effect ?? definitions.learningEffect ?? 'none'],
        ['Action execution', 'Never performed by outcomes commands'],
      ]);
    }
    return response;
  }
}
