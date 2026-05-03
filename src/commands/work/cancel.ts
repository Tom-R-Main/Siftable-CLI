import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkCancel extends WorkActionCommand {
  static description = 'Cancel a work item';
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction('cancel');
  }
}
