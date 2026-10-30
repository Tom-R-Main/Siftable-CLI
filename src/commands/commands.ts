import {BaseCommand} from '../lib/base-command.js';
import {STATIC_READINESS_CAPABILITIES} from '../lib/capabilities.js';
import {RECIPES} from '../lib/recipes.js';
import {renderTable} from '../lib/output.js';

const TOPICS = [
  {topic: 'auth', description: 'Authentication commands'},
  {topic: 'tasks', description: 'Human planning tasks'},
  {topic: 'work', description: 'Executable agent work queue'},
  {topic: 'setup', description: 'First-run setup plans: prepare, check and change them; run them on the plan page'},
  {topic: 'compute', description: 'Task-bound managed compute grants (human-approved worker launches)'},
  {topic: 'agents', description: 'Agent aliases and capabilities'},
  {topic: 'projects', description: 'Project management and context'},
  {topic: 'notes', description: 'Knowledge notes'},
  {topic: 'people', description: 'People and contacts'},
  {topic: 'organizations', description: 'Organizations and companies'},
  {topic: 'lead-discovery', description: 'Governed company discovery, durable runs, and candidate review'},
  {topic: 'relationships', description: 'Evidence-grounded briefs, recommendations, reviews, and canonical actions'},
  {topic: 'calendar', description: 'Calendar events'},
  {topic: 'datasets', description: 'Structured datasets, analysis, and imports'},
  {topic: 'timeline', description: 'Timeline facts and narratives'},
  {topic: 'events', description: 'Research events backed by timeline facts'},
  {topic: 'graph', description: 'Entity graph search and neighborhoods'},
  {topic: 'code memory', description: 'Code memory and facts'},
  {topic: 'vault', description: 'Vault metadata and governed destination-bound materialization'},
  {topic: 'env', description: 'Declarative environment contracts and governed Vault bundle pulls'},
  {topic: 'skills', description: 'Installable Siftable skillpacks'},
  {topic: 'recipes', description: 'Built-in research workflow recipes'},
  {topic: 'research', description: 'Research workflow planning and orchestration'},
  {topic: 'evidence', description: 'Evidence Graph setup and proof workflow orchestration'},
  {topic: 'doctor', description: 'Local CLI environment diagnostics'},
  {topic: 'capabilities', description: 'Capability readiness map'},
];

/** Derive discovery from the same loaded command registry used by dispatch/help. */
export function commandTopics(
  commands: ReadonlyArray<{id: string; hidden?: boolean; description?: string}>,
  configuredTopics: ReadonlyArray<{name: string; description?: string}> = [],
): Array<{topic: string; description: string}> {
  const descriptions = new Map(TOPICS.map(entry => [entry.topic, entry.description]));
  for (const topic of configuredTopics) {
    if (topic.description) descriptions.set(topic.name, topic.description);
  }
  const visible = commands.filter(command => !command.hidden);
  return [...new Set(visible.map(command => command.id.split(':')[0]!))]
    .sort()
    .map(topic => ({
      topic,
      description: descriptions.get(topic)
        ?? visible.find(command => command.id === topic)?.description?.split('\n')[0]
        ?? `${topic} commands`,
    }));
}

export default class Commands extends BaseCommand {
  static description = 'Show agent-friendly command topics and workflow entry points';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(Commands);
    const topics = commandTopics(this.config.commands, this.config.topics);
    const result = {
      ok: true,
      topics,
      capabilityIds: STATIC_READINESS_CAPABILITIES.map((capability) => capability.id),
      recipeIds: RECIPES.map((recipe) => recipe.id),
      next: [
        'Run `sift doctor --json` to verify local auth and API configuration.',
        'Run `sift capabilities --json` to see what is ready, partial, or planned.',
        'Run `sift env --help` for managed .env contracts and governed refresh; use `sift vault materialize run` for an a la carte field.',
        'Run `sift skills list --json` to see installable Siftable skillpacks.',
        'Run `sift recipes list --json` to pick a deterministic workflow.',
      ],
    };

    if (!this.jsonEnabled()) {
      renderTable(topics, [
        {key: 'topic', header: 'Topic'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
