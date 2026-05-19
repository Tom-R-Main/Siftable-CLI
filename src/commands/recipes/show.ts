import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {findRecipe} from '../../lib/recipes.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class RecipesShow extends BaseCommand {
  static description = 'Show a built-in research workflow recipe';

  static args = {
    id: Args.string({description: 'Recipe ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args} = await this.parse(RecipesShow);
    const recipe = findRecipe(args.id);
    if (!recipe) {
      this.error(`Unknown recipe: ${args.id}`);
    }

    const result = {ok: true, recipe};

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Recipe', recipe.id],
        ['Title', recipe.title],
        ['Goal', recipe.goal],
        ['When to use', recipe.whenToUse],
      ]);
      this.log('');
      renderTable(recipe.steps as unknown as Record<string, unknown>[], [
        {key: 'command', header: 'Command'},
        {key: 'purpose', header: 'Purpose'},
        {key: 'writes', header: 'Writes', get: (row) => row.writes ? 'yes' : 'no'},
      ]);
    }

    return result;
  }
}
