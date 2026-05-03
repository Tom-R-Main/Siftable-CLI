import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkComplete extends WorkActionCommand {
  static description = 'Complete a work item';
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction('complete');
  }
}
