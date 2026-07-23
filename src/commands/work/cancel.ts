import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkCancel extends WorkActionCommand {
  static description = 'Cancel queued/blocked work; active work requires --owner and --claim-token';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkCancel, 'cancel');
  }
}
