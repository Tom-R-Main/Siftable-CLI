import {WorkActionCommand} from '../../lib/work-action.js';

export default class WorkRelease extends WorkActionCommand {
  static description = 'Release a claimed work item back to the queue';
  static args = WorkActionCommand.args;
  static flags = WorkActionCommand.baseActionFlags;

  async run(): Promise<unknown> {
    return this.runWorkAction(WorkRelease, 'release');
  }
}
