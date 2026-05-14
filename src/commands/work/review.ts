import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkReview extends WorkActionCommand {
  static description = 'Mark executable agent work as needing human review';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkReview, 'review');
  }
}
