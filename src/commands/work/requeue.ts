import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkRequeue extends WorkActionCommand {
  static description = 'Return blocked work to the queue for a fresh claim';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkRequeue, 'requeue');
  }
}
