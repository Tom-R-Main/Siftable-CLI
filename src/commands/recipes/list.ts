import {BaseCommand} from '../../lib/base-command.js';
import {RECIPES} from '../../lib/recipes.js';
import {renderTable} from '../../lib/output.js';

export default class RecipesList extends BaseCommand {
  static description = 'List built-in research workflow recipes';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(RecipesList);
    const recipes = RECIPES.map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      goal: recipe.goal,
      stepCount: recipe.steps.length,
    }));
    const result = {ok: true, recipes};

    if (!this.jsonEnabled()) {
      renderTable(recipes, [
        {key: 'id', header: 'Recipe'},
        {key: 'title', header: 'Title'},
        {key: 'stepCount', header: 'Steps'},
      ]);
    }

    return result;
  }
}
