import {BaseCommand} from '../../lib/base-command.js';
import {findSkillpacksRoot, listSkillpacks} from '../../lib/skillpacks.js';
import {renderTable} from '../../lib/output.js';

export default class SkillsList extends BaseCommand {
  static description = 'List installable Siftable skillpacks';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(SkillsList);
    const root = findSkillpacksRoot();
    const skillpacks = listSkillpacks(root).map(({id, name, description, sourceDir}) => ({
      id,
      name,
      description,
      sourceDir,
    }));
    const result = {ok: true, root, skillpacks};

    if (!this.jsonEnabled()) {
      renderTable(skillpacks, [
        {key: 'id', header: 'Skillpack'},
        {key: 'name', header: 'Name'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
