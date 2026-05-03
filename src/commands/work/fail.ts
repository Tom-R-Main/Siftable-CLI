import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkFail extends WorkActionCommand {
  static description = 'Mark a work item as failed';
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction('fail');
  }
}
