export const RESEARCH_TEMPLATES = ['sources', 'people', 'events', 'claims'] as const;
export type ResearchTemplateName = (typeof RESEARCH_TEMPLATES)[number];

export interface ResearchPlanStep {
  command: string;
  purpose: string;
  writes: boolean;
}

export interface ResearchPlan {
  goal: string;
  assumptions: string[];
  steps: ResearchPlanStep[];
  verification: string[];
}

export function buildResearchPlan(goal: string, options: {
  projectId?: string;
  sourceDatasetId?: string;
} = {}): ResearchPlan {
  const projectArg = options.projectId ? ` --project ${options.projectId}` : '';
  const sourceDataset = options.sourceDatasetId ?? '<sources-dataset-id>';
  return {
    goal,
    assumptions: [
      'Sources are imported into a sources-template dataset before extraction.',
      'Bulk writes are previewed with dataset diff/import dry-runs before apply.',
      'Long-running extraction uses sift work so another agent can resume.',
    ],
    steps: [
      {
        command: `sift research init "${goal}" --template historical-research`,
        purpose: 'Create the research project and standard datasets if they do not exist yet.',
        writes: true,
      },
      {
        command: `sift datasets templates show sources --json`,
        purpose: 'Inspect the sources contract before shaping source rows.',
        writes: false,
      },
      {
        command: `sift datasets import sources.jsonl --dataset-id ${sourceDataset} --template sources --upsert-by source_id --dry-run --json`,
        purpose: 'Preview source import and validation without writing.',
        writes: false,
      },
      {
        command: `sift datasets import sources.jsonl --dataset-id ${sourceDataset} --template sources --upsert-by source_id --yes --json`,
        purpose: 'Apply reviewed source rows idempotently.',
        writes: true,
      },
      {
        command: `sift research run extract-people --source-dataset ${sourceDataset}${projectArg} --dry-run --json`,
        purpose: 'Preview the agent work item for extracting people.',
        writes: false,
      },
      {
        command: `sift research run extract-events --source-dataset ${sourceDataset}${projectArg} --dry-run --json`,
        purpose: 'Preview the agent work item for extracting events/timeline facts.',
        writes: false,
      },
      {
        command: 'sift datasets validate <people-dataset-id> --template people --json',
        purpose: 'Quality gate extracted people before linking.',
        writes: false,
      },
      {
        command: 'sift graph search "<person or organization>" --json',
        purpose: 'Find stable entity references for graph/timeline inspection.',
        writes: false,
      },
      {
        command: 'sift timeline list --entity person:<id> --order asc --json',
        purpose: 'Inspect chronological facts for a person.',
        writes: false,
      },
      {
        command: 'sift graph explain person:<id> organization:<id> --json',
        purpose: 'Explain bounded graph connections through the server-side entity-link path search.',
        writes: false,
      },
    ],
    verification: [
      'doctor/capabilities commands resolve locally.',
      'dataset imports report no unexpected invalid rows.',
      'people/events datasets validate against templates.',
      'work items include acceptance criteria, write scope, and verification commands.',
      'timeline and graph inspection commands return stable JSON.',
    ],
  };
}

export function researchDatasetFields(template: ResearchTemplateName): Array<Record<string, unknown>> {
  switch (template) {
    case 'sources':
      return [
        {name: 'source_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'title', fieldType: 'text', isRequired: true},
        {name: 'author', fieldType: 'text'},
        {name: 'year', fieldType: 'number'},
        {name: 'source_type', fieldType: 'select'},
        {name: 'url', fieldType: 'url'},
        {name: 'archive_ref', fieldType: 'text'},
        {name: 'reliability', fieldType: 'select'},
        {name: 'notes', fieldType: 'text'},
      ];
    case 'people':
      return [
        {name: 'person_id', fieldType: 'text', isUnique: true},
        {name: 'name', fieldType: 'text', isRequired: true},
        {name: 'normalized_name', fieldType: 'text'},
        {name: 'birth_year', fieldType: 'number'},
        {name: 'death_year', fieldType: 'number'},
        {name: 'roles', fieldType: 'multi_select'},
        {name: 'organizations', fieldType: 'text'},
        {name: 'places', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'source_refs', fieldType: 'text'},
      ];
    case 'events':
      return [
        {name: 'event_id', fieldType: 'text', isUnique: true},
        {name: 'title', fieldType: 'text', isRequired: true},
        {name: 'year', fieldType: 'number'},
        {name: 'date', fieldType: 'date'},
        {name: 'precision', fieldType: 'select'},
        {name: 'place', fieldType: 'text'},
        {name: 'participants', fieldType: 'text'},
        {name: 'event_type', fieldType: 'select'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
      ];
    case 'claims':
      return [
        {name: 'claim_id', fieldType: 'text', isUnique: true},
        {name: 'claim', fieldType: 'text', isRequired: true},
        {name: 'subject_ref', fieldType: 'text'},
        {name: 'predicate', fieldType: 'text'},
        {name: 'object_ref', fieldType: 'text'},
        {name: 'source_ref', fieldType: 'text', isRequired: true},
        {name: 'evidence_quote', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'status', fieldType: 'select'},
      ];
  }
}

export const RESEARCH_RUNS: Record<string, {
  title: string;
  prompt: string;
  acceptanceCriteria: Array<{text: string; met: boolean}>;
  writeScope: Record<string, unknown>;
  verificationCommands: string[];
}> = {
  'extract-people': {
    title: 'Extract research people from sources',
    prompt: 'Extract people from the provided source dataset. Normalize names, preserve provenance, and propose dataset changes through diff-first artifacts.',
    acceptanceCriteria: [
      {text: 'People rows include names, normalized names, confidence, and source refs.', met: false},
      {text: 'Ambiguous people are flagged rather than merged silently.', met: false},
      {text: 'Output includes validation and dedupe commands to run next.', met: false},
    ],
    writeScope: {datasets: ['people'], entities: ['person'], mode: 'diff-first'},
    verificationCommands: [
      'sift datasets validate <people-dataset-id> --template people --json',
      'sift datasets dedupe <people-dataset-id> --key normalized_name --json',
    ],
  },
  'extract-events': {
    title: 'Extract research events from sources',
    prompt: 'Extract events from the provided source dataset. Preserve source refs, dates/precision, participants, and confidence. Prefer timeline-backed event creation only after review.',
    acceptanceCriteria: [
      {text: 'Event rows include title, year/date, precision, participants, source refs, and confidence.', met: false},
      {text: 'Uncertain chronology is represented with precision/confidence instead of invented exact dates.', met: false},
      {text: 'Output includes timeline creation or diff/apply commands for reviewed events.', met: false},
    ],
    writeScope: {datasets: ['events'], entities: ['temporal_fact', 'person', 'organization'], mode: 'diff-first'},
    verificationCommands: [
      'sift datasets validate <events-dataset-id> --template events --json',
      'sift timeline list --entity person:<id> --order asc --json',
    ],
  },
  'link-entities': {
    title: 'Link research people, events, sources, and organizations',
    prompt: 'Review extracted datasets and create or propose explicit entity/timeline/graph links with evidence. Do not infer unsupported relationships.',
    acceptanceCriteria: [
      {text: 'Links cite source rows or notes as evidence.', met: false},
      {text: 'Graph explanations work for sampled linked entities.', met: false},
      {text: 'Unresolved ambiguities are documented.', met: false},
    ],
    writeScope: {entities: ['person', 'organization', 'temporal_fact', 'note'], graph: true, mode: 'reviewed-writes'},
    verificationCommands: [
      'sift graph explain person:<id> organization:<id> --json',
      'sift events list --person <person-id> --json',
    ],
  },
};
