import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkBlock extends WorkActionCommand {
  static description = 'Mark a work item as blocked';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkBlock, 'block');
  }
}
