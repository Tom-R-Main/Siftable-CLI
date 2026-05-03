import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkStart extends WorkActionCommand {
  static description = 'Mark a work item as running';
  static flags = WorkActionCommand.baseActionFlags;
  async run(): Promise<unknown> {
    return this.runWorkAction('start');
  }
}
