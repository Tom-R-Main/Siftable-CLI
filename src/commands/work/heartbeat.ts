import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkHeartbeat extends WorkActionCommand {
  static description = 'Extend a work item lease';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkHeartbeat, 'heartbeat');
  }
}
