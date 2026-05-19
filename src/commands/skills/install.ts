import {Args, Flags} from '@oclif/core';
import {join, resolve} from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {copyDirectory, findSkillpack} from '../../lib/skillpacks.js';

export default class SkillsInstall extends BaseCommand {
  static description = 'Install a Siftable skillpack into a local skills directory';

  static args = {
    id: Args.string({description: 'Skillpack ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    target: Flags.string({
      description: 'Installed skills directory',
      default: 'skills',
    }),
    force: Flags.boolean({description: 'Replace an existing installed skill'}),
    yes: Flags.boolean({char: 'y', description: 'Confirm replacing an existing skill'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SkillsInstall);
    const skillpack = findSkillpack(args.id);
    if (!skillpack) {
      this.error(`Unknown skillpack: ${args.id}`);
    }

    const targetRoot = resolve(flags.target);
    const targetDir = join(targetRoot, skillpack.id);
    const force = flags.force || flags.yes;
    copyDirectory(skillpack.sourceDir, targetDir, {force});

    const result = {
      ok: true,
      installed: {
        id: skillpack.id,
        sourceDir: skillpack.sourceDir,
        targetDir,
      },
    };

    if (!this.jsonEnabled()) {
      this.log(`Installed ${skillpack.id} to ${targetDir}`);
    }

    return result;
  }
}
