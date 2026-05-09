import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkComplete extends WorkActionCommand {
  static description = 'Approve and complete an executable agent work item';
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction('complete');
  }
}
