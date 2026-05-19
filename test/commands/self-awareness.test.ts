import {runCommand} from '../helpers/mock-api';

describe('self-awareness commands', () => {
  it('reports doctor status as stable JSON without requiring auth', async () => {
    const result = await runCommand(['doctor', '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.cli.package).toBe('@siftable/cli');
    expect(typeof parsed.authenticated).toBe('boolean');
    expect(parsed.checks.some((check: any) => check.name === 'auth')).toBe(true);
    expect(parsed.next.length).toBeGreaterThan(0);
  });

  it('lists capabilities as stable JSON', async () => {
    const result = await runCommand(['capabilities', '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.capabilities.some((capability: any) => capability.id === 'datasets.safe_import')).toBe(true);
  });

  it('lists recipes and shows a recipe', async () => {
    const list = await runCommand(['recipes', 'list', '--json']);
    const listed = JSON.parse(list.stdout);
    expect(listed.recipes.some((recipe: any) => recipe.id === 'research-dataset-review')).toBe(true);

    const show = await runCommand(['recipes', 'show', 'research-dataset-review', '--json']);
    const shown = JSON.parse(show.stdout);
    expect(shown.recipe.steps.some((step: any) => step.command.includes('datasets diff'))).toBe(true);
  });

  it('shows command topics as stable JSON', async () => {
    const result = await runCommand(['commands', '--json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.ok).toBe(true);
    expect(parsed.topics.some((topic: any) => topic.topic === 'datasets')).toBe(true);
    expect(parsed.recipeIds).toContain('research-source-ingest');
  });
});
