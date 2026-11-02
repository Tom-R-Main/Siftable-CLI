import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {scopeFlags, setupScope, setupWorkspace} from '../../lib/setupSession.js';

interface PublishedSkill {
  key: string;
  version: number;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export default class SkillsPublished extends BaseCommand {
  static description = 'List the skills published in a workspace (or your personal scope), newest version of each';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(SkillsPublished);
    const scope = setupScope(flags.workspace, (flag) => this.workspaceId(flag));
    const body = await this.apiRequest<{skills: PublishedSkill[]}>(scopeFlags(flags, scope),
      `/api/v1/skills?workspaceId=${encodeURIComponent(setupWorkspace(scope))}`);
    if (!this.jsonEnabled()) {
      renderTable(body.skills.map((skill) => ({...skill, sha256: skill.sha256.slice(0, 12)})), [
        {key: 'key', header: 'Skill'}, {key: 'version', header: 'Version'}, {key: 'sha256', header: 'Digest'},
        {key: 'bytes', header: 'Bytes'}, {key: 'createdAt', header: 'Published'},
      ]);
    }
    return body;
  }
}
