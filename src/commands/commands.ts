import {BaseCommand} from '../lib/base-command.js';
import {CAPABILITIES} from '../lib/capabilities.js';
import {RECIPES} from '../lib/recipes.js';
import {renderTable} from '../lib/output.js';

const TOPICS = [
  {topic: 'auth', description: 'Authentication commands'},
  {topic: 'tasks', description: 'Human planning tasks'},
  {topic: 'work', description: 'Executable agent work queue'},
  {topic: 'agents', description: 'Agent aliases and capabilities'},
  {topic: 'projects', description: 'Project management and context'},
  {topic: 'notes', description: 'Knowledge notes'},
  {topic: 'people', description: 'People and contacts'},
  {topic: 'organizations', description: 'Organizations and companies'},
  {topic: 'calendar', description: 'Calendar events'},
  {topic: 'datasets', description: 'Structured datasets, analysis, and imports'},
  {topic: 'timeline', description: 'Timeline facts and narratives'},
  {topic: 'events', description: 'Research events backed by timeline facts'},
  {topic: 'graph', description: 'Entity graph search and neighborhoods'},
  {topic: 'codebase', description: 'Code indexing and semantic search'},
  {topic: 'code memory', description: 'Code memory and facts'},
  {topic: 'vault', description: 'Secrets vault'},
  {topic: 'skills', description: 'Installable Siftable skillpacks'},
  {topic: 'recipes', description: 'Built-in research workflow recipes'},
  {topic: 'research', description: 'Research workflow planning and orchestration'},
  {topic: 'evidence', description: 'Evidence Graph setup and proof workflow orchestration'},
  {topic: 'doctor', description: 'Local CLI environment diagnostics'},
  {topic: 'capabilities', description: 'Capability readiness map'},
];

export default class Commands extends BaseCommand {
  static description = 'Show agent-friendly command topics and workflow entry points';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(Commands);
    const result = {
      ok: true,
      topics: TOPICS,
      capabilityIds: CAPABILITIES.map((capability) => capability.id),
      recipeIds: RECIPES.map((recipe) => recipe.id),
      next: [
        'Run `sift doctor --json` to verify local auth and API configuration.',
        'Run `sift capabilities --json` to see what is ready, partial, or planned.',
        'Run `sift skills list --json` to see installable Siftable skillpacks.',
        'Run `sift recipes list --json` to pick a deterministic workflow.',
      ],
    };

    if (!this.jsonEnabled()) {
      renderTable(TOPICS, [
        {key: 'topic', header: 'Topic'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
