import {Args, Flags} from '@oclif/core';
import path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {scopeFlags, setupScope, setupWorkspace} from '../../lib/setupSession.js';
import {readSkillFolder} from '../../lib/skills/skillFolder.js';

interface PublishedSkill {
  key: string;
  version: number;
  sha256: string;
  bytes: number;
}

export default class SkillsPublish extends BaseCommand {
  static description = 'Publish a skill folder (SKILL.md and its files) as a new version a setup plan can pin';

  static examples = [
    '<%= config.bin %> skills publish ./skills/date-parsing',
    '<%= config.bin %> skills publish ./my-skill --key date-parsing --workspace personal --json',
  ];

  static args = {
    dir: Args.string({description: 'The skill folder', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    key: Flags.string({description: 'Skill key (lowercase letters, digits and dashes); defaults to the folder name'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SkillsPublish);
    const root = path.resolve(args.dir);
    const key = flags.key ?? path.basename(root).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(key)) this.error(`"${key}" is not a skill key; pass --key with lowercase letters, digits and dashes`);
    let files: Array<{path: string; content: string}>;
    try {
      files = readSkillFolder(root);
    } catch (error) {
      this.error((error as Error).message);
    }
    const scope = setupScope(flags.workspace, (flag) => this.workspaceId(flag));
    const body = await this.apiRequest<{skill: PublishedSkill; replayed: boolean}>(scopeFlags(flags, scope),
      `/api/v1/skills/${encodeURIComponent(key)}/versions`, {
        method: 'POST',
        body: {workspaceId: setupWorkspace(scope), surface: 'cli', files},
      });
    if (!this.jsonEnabled()) {
      const {skill} = body;
      this.log(`${skill.key} v${skill.version} (sha256:${skill.sha256})${body.replayed ? ', already published' : ''}`);
      this.log(`Pin it in a plan with skills: [{"key": "${skill.key}", "version": ${skill.version}}]`);
    }
    return body;
  }
}
