import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodebaseRegister extends BaseCommand {
  static description = 'Deprecated hosted repository-ingestion path (blocked by default)';

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Repository name', required: true}),
    path: Flags.string({description: 'Absolute path to repository root', required: true}),
    project: Flags.string({description: 'Project ID to associate'}),
    'auto-index': Flags.boolean({description: 'Enable automatic indexing'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodebaseRegister);
    const client = await this.client(flags);
    const response = await client.createCodeRepository({
      name: flags.name,
      rootPath: flags.path,
      projectId: flags.project,
    });

    if (response.statusCode === 410 && response.error) {
      try {
        const problem = JSON.parse(response.error) as Record<string, unknown>;
        const detail = typeof problem.detail === 'string' ? problem.detail : response.error;
        const action = typeof problem.action === 'string' ? problem.action : undefined;
        const error = new Error(
          `[${String(problem.code || 'CODEBASE_INGESTION_DEPRECATED')}] ${detail}${action ? ` Action: ${action}` : ''}`,
        ) as Error & {
          code?: string;
          statusCode?: number;
          api?: Record<string, unknown>;
          suggestions?: string[];
        };
        error.code = String(problem.code || 'CODEBASE_INGESTION_DEPRECATED');
        error.statusCode = response.statusCode;
        error.api = problem;
        error.suggestions = action ? [action] : undefined;
        this.error(error, {exit: response.statusCode});
      } catch (err) {
        if (err instanceof SyntaxError) {
          this.error(response.error, {exit: response.statusCode});
        }
        throw err;
      }
    }

    this.handleApiError(response);

    const repo = this.unwrapOne(response, 'repository');

    if (!this.jsonEnabled()) {
      this.log(`Repository registered: ${repo.id}`);
    }

    return response.data;
  }
}
