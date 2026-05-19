export interface Capability {
  id: string;
  status: 'ready' | 'partial' | 'planned';
  commands: string[];
  description: string;
  next?: string[];
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'cli.self_awareness',
    status: 'ready',
    commands: ['sift doctor', 'sift capabilities', 'sift commands', 'sift recipes list', 'sift recipes show'],
    description: 'Discover local auth, API/workspace configuration, command topics, and recommended research workflows.',
  },
  {
    id: 'datasets.inspect',
    status: 'ready',
    commands: ['sift datasets templates list', 'sift datasets templates show', 'sift datasets profile', 'sift datasets facets', 'sift datasets validate'],
    description: 'Inspect template contracts and bounded dataset shape before reading or writing large tables.',
  },
  {
    id: 'datasets.safe_import',
    status: 'ready',
    commands: ['sift datasets import --dry-run', 'sift datasets import --upsert-by', 'sift datasets diff', 'sift datasets apply-diff'],
    description: 'Preview and apply idempotent CSV, JSON, or JSONL dataset changes with reviewable plans.',
  },
  {
    id: 'datasets.derive',
    status: 'partial',
    commands: ['sift datasets lookup', 'sift datasets search', 'sift datasets dedupe', 'sift datasets reconcile', 'sift datasets pivot', 'sift datasets formula-plan', 'sift datasets query', 'sift datasets aggregate', 'sift datasets bucket', 'sift datasets rank', 'sift datasets compare', 'sift datasets join', 'sift datasets compute', 'sift datasets timeseries', 'sift datasets plot', 'sift datasets materialize'],
    description: 'Perform spreadsheet-like lookup, search, duplicate review, reconciliation, pivots, formula planning, analysis, and explicitly materialized derived outputs.',
  },
  {
    id: 'agent.work',
    status: 'ready',
    commands: ['sift agents list', 'sift work create', 'sift work claim', 'sift work start', 'sift work heartbeat', 'sift work complete', 'sift work review'],
    description: 'Represent long-running agent execution as resumable work items with evidence and review states.',
  },
  {
    id: 'research.workflow',
    status: 'ready',
    commands: ['sift research plan', 'sift research init', 'sift research status', 'sift research run'],
    description: 'Plan research workflows, initialize standard datasets, inspect readiness, and queue resumable agent research work.',
  },
  {
    id: 'research.timeline',
    status: 'ready',
    commands: ['sift timeline list', 'sift timeline create', 'sift timeline delete', 'sift timeline narrative', 'sift events create', 'sift events list', 'sift events attach-person'],
    description: 'Create, list, retract, narrate, and attach people to timeline-backed research events.',
  },
  {
    id: 'research.people',
    status: 'ready',
    commands: ['sift people get', 'sift people list', 'sift people search', 'sift people create', 'sift people update', 'sift people relate', 'sift people graph', 'sift people kinship', 'sift people timeline'],
    description: 'Create, inspect, relate, graph, and timeline people as research entities rather than flat contact rows.',
  },
  {
    id: 'research.graph',
    status: 'ready',
    commands: ['sift graph search', 'sift graph preview', 'sift graph neighbors', 'sift graph explain', 'sift graph between'],
    description: 'Search graph entities, inspect local neighborhoods, and explain bounded server-side paths across people, events, sources, notes, and organizations.',
    next: ['Add richer evidence summaries for graph paths, including source snippets and review status.'],
  },
];
