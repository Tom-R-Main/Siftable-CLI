import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkReview extends WorkActionCommand {
  static description = 'Mark a work item as needing review';
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction('review');
  }
}
