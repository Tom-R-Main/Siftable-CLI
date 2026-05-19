export interface RecipeStep {
  command: string;
  purpose: string;
  writes?: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  goal: string;
  whenToUse: string;
  steps: RecipeStep[];
  verification: string[];
}

export const RECIPES: Recipe[] = [
  {
    id: 'research-source-ingest',
    title: 'Import and validate research sources',
    goal: 'Safely load source rows, validate them against the sources template, and inspect the resulting dataset shape.',
    whenToUse: 'Use before extraction when source metadata arrives as CSV, JSON, or JSONL.',
    steps: [
      {
        command: 'sift datasets templates show sources --json',
        purpose: 'Inspect the required source schema before preparing rows.',
      },
      {
        command: 'sift datasets import sources.jsonl --dataset-id <id> --template sources --upsert-by source_id --dry-run --json',
        purpose: 'Preview creates, updates, skips, validation errors, and warnings without writing.',
      },
      {
        command: 'sift datasets import sources.jsonl --dataset-id <id> --template sources --upsert-by source_id --yes --json',
        purpose: 'Apply the idempotent import once the dry-run is acceptable.',
        writes: true,
      },
      {
        command: 'sift datasets profile <id> --json',
        purpose: 'Confirm row count, columns, nulls, and bounded sample rows.',
      },
      {
        command: 'sift datasets validate <id> --template sources --json',
        purpose: 'Run the template quality gate after import.',
      },
    ],
    verification: [
      'The dry-run summary matches the intended write.',
      'The applied import reports no unexpected invalid rows.',
      'Template validation has no errors.',
    ],
  },
  {
    id: 'research-dataset-review',
    title: 'Review dataset changes before applying them',
    goal: 'Produce a reusable diff plan, review it, then apply the exact same rows deliberately.',
    whenToUse: 'Use when an agent proposes bulk dataset edits or extracted rows.',
    steps: [
      {
        command: 'sift datasets diff <dataset-id> --from-file proposed.jsonl --template sources --upsert-by source_id --save-plan diff-plan.json --json',
        purpose: 'Create a dry-run import plan and save the exact rows/options needed to apply it later.',
      },
      {
        command: 'sift datasets apply-diff diff-plan.json --yes --json',
        purpose: 'Apply the saved plan after review.',
        writes: true,
      },
      {
        command: 'sift datasets validate <dataset-id> --template sources --json',
        purpose: 'Verify the dataset remains valid after applying the diff.',
      },
    ],
    verification: [
      'Saved plan contains the expected dataset ID, upsert key, and row count.',
      'Apply summary matches the reviewed dry-run summary unless concurrent data changed.',
      'Post-apply validation has no errors.',
    ],
  },
  {
    id: 'agent-work-research-loop',
    title: 'Create resumable agent research work',
    goal: 'Queue research execution as a work item with acceptance criteria, write scope, and verification commands.',
    whenToUse: 'Use when extraction, reconciliation, or linking is too large for a single direct CLI command.',
    steps: [
      {
        command: 'sift work create --title "<title>" --agent researcher --project <project-id> --context-file context.json --acceptance-criteria "<criteria>" --write-scope \'{"datasets":["<id>"],"entities":["person","temporal_fact"]}\' --json',
        purpose: 'Create an agent-executable work item rather than a human planning task.',
        writes: true,
      },
      {
        command: 'sift research run extract-people --source-dataset <sources-dataset-id> --project <project-id> --dry-run --json',
        purpose: 'Use the research wrapper to preview a structured work item payload before queueing it.',
      },
      {
        command: 'sift work claim --agent researcher --json',
        purpose: 'Let an agent claim the next executable item.',
      },
      {
        command: 'sift work complete <work-id> --evidence-file evidence.json --json',
        purpose: 'Complete work with structured evidence of commands, artifacts, and validation status.',
        writes: true,
      },
    ],
    verification: [
      'Work item includes explicit acceptance criteria.',
      'Write scope names the datasets and entity types the agent may change.',
      'Completion evidence includes commands run and validation results.',
    ],
  },
  {
    id: 'grounding-verdict',
    title: 'Create an evidence-backed grounding verdict',
    goal: 'Ground a library, repository, model, or implementation-pattern decision in Siftable context plus deterministic evidence before acting.',
    whenToUse: 'Use before adding dependencies, copying a reference repo, changing model routing, or implementing a pattern where prior context and live evidence matter.',
    steps: [
      {
        command: 'sift notes search "verdict <entity-name>" --json',
        purpose: 'Check for an existing Siftable verdict before fetching new evidence.',
      },
      {
        command: 'sift code memory search "<entity-name>" --json',
        purpose: 'Find prior integration facts, conventions, gotchas, and ownership notes.',
      },
      {
        command: 'sift codebase search "<entity-name>" --repo <repo-id> --json',
        purpose: 'Find current local usage or relevant implementation seams.',
      },
      {
        command: 'sift notes create --title "Verdict: <entity-name>" --type reference --metadata \'{"kind":"verdict","entityType":"library","entityName":"<entity-name>","recommendation":"spike","confidence":"low","fetchedAt":"<iso>","freshnessTtlDays":30,"evidenceUrls":[],"signals":{}}\' --content "<verdict markdown>" --json',
        purpose: 'Persist the structured verdict note once evidence has been reviewed.',
        writes: true,
      },
    ],
    verification: [
      'Existing Siftable context was checked before external research.',
      'Verdict metadata includes kind, entity type, recommendation, confidence, fetchedAt, freshness TTL, evidence URLs, and signals.',
      'The markdown verdict includes recommendation, evidence, risks, alternatives, implementation plan, and verification commands.',
    ],
  },
];

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}
