import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';
import {
  WorkContractValidationError,
  checkWorkContract,
  checkWorkItemContract,
} from '../../../lib/work-contract.js';

export default class WorkContractCheck extends BaseCommand {
  static description = 'Deterministically validate a Work Contract V1 file or fetched work item';

  static args = {
    id: Args.string({description: 'Work item ID to fetch and validate'}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({description: 'Path to a Work Contract V1 JSON file'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkContractCheck);
    if (Boolean(args.id) === Boolean(flags.file)) {
      this.error('Provide exactly one work item ID or --file.');
    }

    let candidate: unknown;
    let source: {kind: 'file'; path: string} | {kind: 'work_item'; id: string};
    if (flags.file) {
      candidate = this.parseJsonInput<unknown>(undefined, flags.file, 'contract');
      source = {kind: 'file', path: flags.file};
    } else {
      const client = await this.client(flags);
      const response = await client.getWorkItem(args.id!);
      this.handleApiError(response);
      candidate = this.unwrapOne(response, 'workItem');
      source = {kind: 'work_item', id: args.id!};
    }

    const result = source.kind === 'file'
      ? checkWorkContract(candidate)
      : checkWorkItemContract(candidate);
    if (!result.valid) {
      this.error(new WorkContractValidationError(result), {exit: 2});
    }
    const output = {...result, source};
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Valid', 'yes'],
        ['Classification', result.classification],
        ['Profile', result.contract?.profile],
        ['Version', result.contract?.version],
        ['Source', source.kind === 'file' ? source.path : source.id],
      ]);
    }
    return output;
  }
}
