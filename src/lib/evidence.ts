export const EVIDENCE_PACKS = [
  'company-origin',
  'family-history',
  'investigation',
  'compliance-evidence',
  'account-history',
  'codebase-history',
] as const;

export type EvidencePack = (typeof EVIDENCE_PACKS)[number];

export const EVIDENCE_TEMPLATES = [
  'evidence_sources',
  'evidence_source_fragments',
  'evidence_claims',
  'evidence_people',
  'evidence_organizations',
  'evidence_places',
  'evidence_artifacts',
  'evidence_events',
  'evidence_relationships',
  'evidence_contradictions',
] as const;

export type EvidenceTemplateName = (typeof EVIDENCE_TEMPLATES)[number];

export const EVIDENCE_EXTRACTION_TARGETS = [
  'people',
  'orgs',
  'places',
  'artifacts',
  'events',
  'claims',
  'relationships',
  'contradictions',
] as const;

export type EvidenceExtractionTarget = (typeof EVIDENCE_EXTRACTION_TARGETS)[number];

export interface EvidencePlanStep {
  command: string;
  purpose: string;
  writes: boolean;
}

export interface EvidencePlan {
  goal: string;
  pack: EvidencePack;
  assumptions: string[];
  steps: EvidencePlanStep[];
  verification: string[];
}

export interface EvidenceExtractionWork {
  title: string;
  prompt: string;
  acceptanceCriteria: Array<{text: string; met: boolean}>;
  writeScope: Record<string, unknown>;
  verificationCommands: string[];
}

export interface EvidencePacket {
  project?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  fragments?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  relationships?: Array<Record<string, unknown>>;
  contradictions?: Array<Record<string, unknown>>;
  diffPlans?: Array<Record<string, unknown>>;
  operations?: Array<Record<string, unknown>>;
  projection?: Record<string, unknown>;
  narrative?: {
    paragraphs?: Array<{
      text: string;
      factual?: boolean;
      citations?: string[];
    }>;
  };
}

export interface EvidenceVerificationFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  ref?: string;
}

export interface EvidenceDiffSummary {
  sources: number;
  sourceFragments: number;
  claims: number;
  people: number;
  organizations: number;
  places: number;
  artifacts: number;
  events: number;
  relationships: number;
  contradictions: number;
  operations: number;
}

export interface EvidenceProjectionPreview {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  timelineFacts: Array<Record<string, unknown>>;
  relationshipClaims: Array<Record<string, unknown>>;
  contradictionRadar: Array<Record<string, unknown>>;
  sourceRowExplanations: Array<Record<string, unknown>>;
}

export const EMPTY_EVIDENCE_DIFF_SUMMARY: EvidenceDiffSummary = {
  sources: 0,
  sourceFragments: 0,
  claims: 0,
  people: 0,
  organizations: 0,
  places: 0,
  artifacts: 0,
  events: 0,
  relationships: 0,
  contradictions: 0,
  operations: 0,
};

export function buildEvidencePlan(goal: string, options: {
  pack?: EvidencePack;
  projectId?: string;
  sourceDatasetId?: string;
} = {}): EvidencePlan {
  const pack = options.pack ?? 'company-origin';
  const projectArg = options.projectId ? ` --project ${options.projectId}` : '';
  const sourceDataset = options.sourceDatasetId ?? '<evidence-sources-dataset-id>';
  return {
    goal,
    pack,
    assumptions: [
      'Evidence Graph v1 is dataset-backed; first-class evidence tables are deferred.',
      'Company Origin is the default golden path unless another pack is selected explicitly.',
      'Agents may propose rows, work items, diff plans, and reports, but durable assertions require review.',
      'Timeline and relationship views are projections from reviewed evidence rows.',
    ],
    steps: [
      {
        command: `sift evidence init "${goal}" --pack ${pack}`,
        purpose: 'Create or preview the Evidence Graph project and dataset-backed working tables.',
        writes: true,
      },
      {
        command: `sift evidence sources import ./archive --dataset-id ${sourceDataset} --dry-run --json`,
        purpose: 'Preview source ledger import without writing durable state.',
        writes: false,
      },
      {
        command: `sift evidence sources import ./archive --dataset-id ${sourceDataset} --yes --json`,
        purpose: 'Import reviewed source ledger rows.',
        writes: true,
      },
      {
        command: `sift evidence extract --targets people,orgs,events,claims,relationships,contradictions --source-dataset ${sourceDataset}${projectArg} --no-apply --json`,
        purpose: 'Queue or preview extraction work that proposes evidence rows without applying trusted graph state.',
        writes: true,
      },
      {
        command: `sift evidence diff list${projectArg} --json`,
        purpose: 'Find reviewable evidence diff plans.',
        writes: false,
      },
      {
        command: 'sift evidence diff impact <diff-plan-id> --json',
        purpose: 'Explain typed consequences before apply: claims, events, relationships, contradictions, timeline, and graph impact.',
        writes: false,
      },
      {
        command: 'sift evidence project --project <project-id> --pack <pack> --from-plan <diff-plan-id> --dry-run --json',
        purpose: 'Preview graph and timeline projection without writing accepted facts.',
        writes: false,
      },
      {
        command: 'sift evidence verify --project <project-id> --json',
        purpose: 'Fail fast on unsupported accepted facts, silent identity merges, missing provenance, and uncited proof claims.',
        writes: false,
      },
      {
        command: 'sift evidence proof report --project <project-id> --format markdown',
        purpose: 'Generate a sourced proof packet with reproducibility metadata.',
        writes: false,
      },
    ],
    verification: [
      'Dry-run commands do not mutate durable state.',
      'Source ledger rows validate against evidence_sources.',
      'Proposed claims/events/relationships keep source refs and review status.',
      'Diff impact is reviewed before apply.',
      'Projection dry-run explains source-row to temporal/relationship paths.',
      'Proof report separates proven, probable, inferred, contradicted, unsupported, and open-question content.',
    ],
  };
}

export function parseEvidenceTargets(value: string | undefined): EvidenceExtractionTarget[] {
  const rawTargets = (value ?? 'people,orgs,events,claims,relationships,contradictions')
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  const allowed = new Set<string>(EVIDENCE_EXTRACTION_TARGETS);
  const invalid = rawTargets.filter((target) => !allowed.has(target));
  if (invalid.length > 0) {
    throw new Error(`Invalid evidence extraction target(s): ${invalid.join(', ')}. Allowed: ${EVIDENCE_EXTRACTION_TARGETS.join(', ')}.`);
  }
  return rawTargets as EvidenceExtractionTarget[];
}

export function buildEvidenceExtractionWork(input: {
  pack: EvidencePack;
  targets: EvidenceExtractionTarget[];
  sourceDatasetId: string;
  projectId?: string;
  context?: Record<string, unknown>;
}): EvidenceExtractionWork {
  const targets = input.targets;
  const targetText = targets.join(', ');
  return {
    title: `Extract Evidence Graph candidates: ${targetText}`,
    prompt: [
      `Extract ${targetText} candidates for the ${input.pack} Evidence Graph workflow.`,
      'Use the provided source dataset as the source ledger.',
      'Preserve source refs, evidence quotes or locators, confidence, review status, and projection status.',
      'Create proposed dataset rows, persisted diff plans, and verification/proof artifacts only.',
      'Do not apply durable assertions, accept claims, merge identities, resolve contradictions, delete evidence, or publish final narratives.',
    ].join(' '),
    acceptanceCriteria: [
      {text: 'Output rows keep source refs or explicit provenance gaps for every proposed assertion.', met: false},
      {text: 'Claims/events/relationships remain proposed until reviewed through a diff plan.', met: false},
      {text: 'Ambiguous identities and contradictions are flagged rather than merged or resolved silently.', met: false},
      {text: 'Result includes diff plan IDs or explicit next commands to create them.', met: false},
      {text: 'Verification commands are included and can run without reading vault secrets.', met: false},
    ],
    writeScope: {
      mode: 'diff-first',
      noApply: true,
      sourceDatasetId: input.sourceDatasetId,
      datasets: targets.map((target) => `evidence_${target === 'orgs' ? 'organizations' : target}`),
      forbidden: ['apply_durable_assertions', 'accept_claims', 'merge_identities', 'resolve_contradictions', 'delete_evidence', 'read_vault'],
    },
    verificationCommands: [
      `sift evidence diff list${input.projectId ? ` --project ${input.projectId}` : ''} --json`,
      `sift evidence verify${input.projectId ? ` --project ${input.projectId}` : ' --project <project-id>'} --json`,
      `sift evidence proof report${input.projectId ? ` --project ${input.projectId}` : ' --project <project-id>'} --format json`,
    ],
  };
}

export function verifyEvidencePacket(packet: EvidencePacket): {
  ok: boolean;
  findings: EvidenceVerificationFinding[];
  summary: Record<string, number>;
} {
  const findings: EvidenceVerificationFinding[] = [];
  const claims = packet.claims ?? [];
  const events = packet.events ?? [];
  const relationships = packet.relationships ?? [];
  const contradictions = packet.contradictions ?? [];
  const narrativeParagraphs = packet.narrative?.paragraphs ?? [];

  for (const claim of claims) {
    const status = normalizedStatus(claim.claim_status ?? claim.status ?? claim.review_status);
    const inferred = isInferredStatus(status);
    const accepted = isAcceptedStatus(status) || isAcceptedStatus(claim.review_status);
    if (accepted && !inferred && !hasAnyValue(claim.source_ref, claim.source_refs, claim.source_fragment_ref, claim.evidence_quote)) {
      findings.push({
        severity: 'error',
        code: 'accepted_claim_missing_provenance',
        message: 'Accepted claim is missing source provenance.',
        ref: String(claim.claim_id ?? claim.id ?? claim.claim_text ?? 'claim'),
      });
    }
  }

  for (const event of events) {
    const projected = isProjectedStatus(event.projection_status);
    const inferred = isInferredStatus(event.event_status ?? event.status);
    if (projected && !inferred && !hasAnyValue(event.source_refs, event.claim_refs)) {
      findings.push({
        severity: 'error',
        code: 'projected_event_missing_evidence',
        message: 'Projected event is missing source or claim references.',
        ref: String(event.event_id ?? event.id ?? event.title ?? 'event'),
      });
    }
  }

  for (const relationship of relationships) {
    const projected = isProjectedStatus(relationship.projection_status);
    const inferred = isInferredStatus(relationship.relationship_status ?? relationship.status);
    if (projected && !inferred && !hasAnyValue(relationship.source_refs, relationship.claim_refs)) {
      findings.push({
        severity: 'error',
        code: 'projected_relationship_missing_evidence',
        message: 'Projected relationship is missing source or claim references.',
        ref: String(relationship.relationship_id ?? relationship.id ?? 'relationship'),
      });
    }
  }

  for (const paragraph of narrativeParagraphs) {
    if (paragraph.factual !== false && (!Array.isArray(paragraph.citations) || paragraph.citations.length === 0)) {
      findings.push({
        severity: 'error',
        code: 'factual_narrative_missing_citation',
        message: 'Factual narrative paragraph is missing citations.',
        ref: paragraph.text.slice(0, 80),
      });
    }
  }

  if (contradictions.length > 0 && !contradictions.some((item) => normalizedStatus(item.review_status ?? item.status))) {
    findings.push({
      severity: 'warning',
      code: 'contradictions_without_review_status',
      message: 'Contradictions are present but none include review status.',
    });
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
    summary: {
      sources: (packet.sources ?? []).length,
      fragments: (packet.fragments ?? []).length,
      claims: claims.length,
      events: events.length,
      relationships: relationships.length,
      contradictions: contradictions.length,
      diffPlans: (packet.diffPlans ?? []).length,
      operations: (packet.operations ?? []).length,
      narrativeParagraphs: narrativeParagraphs.length,
    },
  };
}

export function buildEvidenceProofReport(packet: EvidencePacket): Record<string, unknown> {
  const verification = verifyEvidencePacket(packet);
  const claims = packet.claims ?? [];
  return {
    ok: verification.ok,
    reportVersion: 'evidence-proof.v1',
    project: packet.project ?? null,
    summary: verification.summary,
    sources: packet.sources ?? [],
    claims: {
      proven: claims.filter((claim) => isAcceptedStatus(claim.claim_status ?? claim.status ?? claim.review_status)),
      probable: claims.filter((claim) => normalizedStatus(claim.claim_status ?? claim.status) === 'probable'),
      inferred: claims.filter((claim) => isInferredStatus(claim.claim_status ?? claim.status)),
      contradicted: claims.filter((claim) => normalizedStatus(claim.claim_status ?? claim.status) === 'contradicted'),
      unsupported: claims.filter((claim) => !hasAnyValue(claim.source_ref, claim.source_refs, claim.source_fragment_ref, claim.evidence_quote)),
      openQuestions: claims.filter((claim) => normalizedStatus(claim.review_status ?? claim.status) === 'needs_review'),
    },
    timeline: packet.events ?? [],
    relationships: packet.relationships ?? [],
    contradictions: packet.contradictions ?? [],
    narrative: packet.narrative ?? {paragraphs: []},
    verification,
    reproducibility: {
      diffPlanIds: (packet.diffPlans ?? []).map((plan) => plan.id).filter(Boolean),
      operationIds: (packet.operations ?? []).map((operation) => operation.id ?? operation.operationId).filter(Boolean),
      projection: packet.projection ?? null,
      commands: [
        'sift evidence verify --from-file <packet.json> --json',
        'sift evidence proof report --from-file <packet.json> --format json',
        'sift evidence proof report --from-file <packet.json> --format markdown',
      ],
    },
  };
}

export function renderEvidenceProofMarkdown(report: Record<string, any>): string {
  const lines: string[] = [];
  lines.push('# Evidence Graph Proof Report');
  lines.push('');
  lines.push(`Status: ${report.ok ? 'PASS' : 'NEEDS REVIEW'}`);
  lines.push(`Version: ${report.reportVersion}`);
  lines.push('');
  lines.push('## Summary');
  for (const [key, value] of Object.entries(report.summary ?? {})) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Claims');
  lines.push(`- proven: ${report.claims?.proven?.length ?? 0}`);
  lines.push(`- probable: ${report.claims?.probable?.length ?? 0}`);
  lines.push(`- inferred: ${report.claims?.inferred?.length ?? 0}`);
  lines.push(`- contradicted: ${report.claims?.contradicted?.length ?? 0}`);
  lines.push(`- unsupported: ${report.claims?.unsupported?.length ?? 0}`);
  lines.push(`- open questions: ${report.claims?.openQuestions?.length ?? 0}`);
  lines.push('');
  lines.push('## Contradictions');
  const contradictions = report.contradictions ?? [];
  if (contradictions.length === 0) {
    lines.push('- none');
  } else {
    for (const contradiction of contradictions) {
      lines.push(`- ${contradiction.contradiction_id ?? contradiction.id ?? 'contradiction'}: ${contradiction.summary ?? contradiction.contradiction_type ?? 'Needs review'}`);
    }
  }
  lines.push('');
  lines.push('## Narrative');
  const paragraphs = report.narrative?.paragraphs ?? [];
  if (paragraphs.length === 0) {
    lines.push('No narrative paragraphs supplied.');
  } else {
    for (const paragraph of paragraphs) {
      const citations = Array.isArray(paragraph.citations) && paragraph.citations.length > 0
        ? ` [${paragraph.citations.join(', ')}]`
        : '';
      lines.push(`${paragraph.text}${citations}`);
      lines.push('');
    }
  }
  lines.push('## Verification Findings');
  const findings = report.verification?.findings ?? [];
  if (findings.length === 0) {
    lines.push('- none');
  } else {
    for (const finding of findings) {
      lines.push(`- ${finding.severity}: ${finding.code}${finding.ref ? ` (${finding.ref})` : ''} - ${finding.message}`);
    }
  }
  lines.push('');
  lines.push('## Reproducibility');
  lines.push(`- diff plan ids: ${(report.reproducibility?.diffPlanIds ?? []).join(', ') || 'none'}`);
  lines.push(`- operation ids: ${(report.reproducibility?.operationIds ?? []).join(', ') || 'none'}`);
  for (const command of report.reproducibility?.commands ?? []) {
    lines.push(`- \`${command}\``);
  }
  lines.push('');
  return lines.join('\n');
}

function normalizedStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isAcceptedStatus(value: unknown): boolean {
  return ['accepted', 'supported', 'proven', 'verified'].includes(normalizedStatus(value));
}

function isProjectedStatus(value: unknown): boolean {
  return ['projected', 'applied'].includes(normalizedStatus(value));
}

function isInferredStatus(value: unknown): boolean {
  return ['inferred', 'hypothetical'].includes(normalizedStatus(value));
}

function hasAnyValue(...values: unknown[]): boolean {
  return values.some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== undefined && value !== null;
  });
}

export function evidenceDatasetFields(template: EvidenceTemplateName): Array<Record<string, unknown>> {
  switch (template) {
    case 'evidence_sources':
      return [
        {name: 'source_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'title', fieldType: 'text', isRequired: true},
        {name: 'source_type', fieldType: 'select'},
        {name: 'original_path_or_url', fieldType: 'text'},
        {name: 'repository_or_site', fieldType: 'text'},
        {name: 'author_or_creator', fieldType: 'text'},
        {name: 'source_date', fieldType: 'date'},
        {name: 'source_date_precision', fieldType: 'select'},
        {name: 'hash', fieldType: 'text'},
        {name: 'rights_or_visibility', fieldType: 'select'},
        {name: 'imported_at', fieldType: 'date'},
        {name: 'import_run_id', fieldType: 'text'},
        {name: 'extraction_status', fieldType: 'select'},
        {name: 'notes', fieldType: 'text'},
      ];
    case 'evidence_source_fragments':
      return [
        {name: 'fragment_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'source_ref', fieldType: 'text', isRequired: true},
        {name: 'fragment_type', fieldType: 'select'},
        {name: 'locator', fieldType: 'text'},
        {name: 'quote_or_text', fieldType: 'text'},
        {name: 'page', fieldType: 'number'},
        {name: 'timestamp', fieldType: 'text'},
        {name: 'region', fieldType: 'text'},
        {name: 'language', fieldType: 'text'},
        {name: 'extraction_run_id', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'review_status', fieldType: 'select'},
      ];
    case 'evidence_claims':
      return [
        {name: 'claim_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'claim_text', fieldType: 'text', isRequired: true},
        {name: 'subject_ref', fieldType: 'text'},
        {name: 'predicate', fieldType: 'text'},
        {name: 'object_ref', fieldType: 'text'},
        {name: 'qualifier', fieldType: 'text'},
        {name: 'source_ref', fieldType: 'text'},
        {name: 'source_fragment_ref', fieldType: 'text'},
        {name: 'evidence_quote', fieldType: 'text'},
        {name: 'evidence_role', fieldType: 'select'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'claim_status', fieldType: 'select'},
        {name: 'review_status', fieldType: 'select'},
        {name: 'projection_status', fieldType: 'select'},
        {name: 'analysis_note', fieldType: 'text'},
        {name: 'contradicts_claim_refs', fieldType: 'text'},
        {name: 'created_by_run_id', fieldType: 'text'},
      ];
    case 'evidence_people':
      return [
        {name: 'person_id', fieldType: 'text', isUnique: true},
        {name: 'name', fieldType: 'text', isRequired: true},
        {name: 'normalized_name', fieldType: 'text'},
        {name: 'roles', fieldType: 'multi_select'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'review_status', fieldType: 'select'},
      ];
    case 'evidence_organizations':
      return [
        {name: 'organization_id', fieldType: 'text', isUnique: true},
        {name: 'name', fieldType: 'text', isRequired: true},
        {name: 'normalized_name', fieldType: 'text'},
        {name: 'organization_type', fieldType: 'select'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'review_status', fieldType: 'select'},
      ];
    case 'evidence_places':
      return [
        {name: 'place_id', fieldType: 'text', isUnique: true},
        {name: 'name', fieldType: 'text', isRequired: true},
        {name: 'normalized_name', fieldType: 'text'},
        {name: 'place_type', fieldType: 'select'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
      ];
    case 'evidence_artifacts':
      return [
        {name: 'artifact_id', fieldType: 'text', isUnique: true},
        {name: 'title', fieldType: 'text', isRequired: true},
        {name: 'artifact_type', fieldType: 'select'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
      ];
    case 'evidence_events':
      return [
        {name: 'event_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'event_type', fieldType: 'select'},
        {name: 'title', fieldType: 'text', isRequired: true},
        {name: 'description', fieldType: 'text'},
        {name: 'time_start', fieldType: 'date'},
        {name: 'time_end', fieldType: 'date'},
        {name: 'time_precision', fieldType: 'select'},
        {name: 'calendar_system', fieldType: 'select'},
        {name: 'place_ref', fieldType: 'text'},
        {name: 'participant_refs', fieldType: 'text'},
        {name: 'participant_roles', fieldType: 'text'},
        {name: 'claim_refs', fieldType: 'text'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'event_status', fieldType: 'select'},
        {name: 'review_status', fieldType: 'select'},
        {name: 'projection_status', fieldType: 'select'},
      ];
    case 'evidence_relationships':
      return [
        {name: 'relationship_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'relationship_type', fieldType: 'select'},
        {name: 'subject_ref', fieldType: 'text', isRequired: true},
        {name: 'object_ref', fieldType: 'text', isRequired: true},
        {name: 'time_start', fieldType: 'date'},
        {name: 'time_end', fieldType: 'date'},
        {name: 'time_precision', fieldType: 'select'},
        {name: 'claim_refs', fieldType: 'text'},
        {name: 'source_refs', fieldType: 'text'},
        {name: 'confidence', fieldType: 'number'},
        {name: 'relationship_status', fieldType: 'select'},
        {name: 'review_status', fieldType: 'select'},
        {name: 'projection_status', fieldType: 'select'},
      ];
    case 'evidence_contradictions':
      return [
        {name: 'contradiction_id', fieldType: 'text', isRequired: true, isUnique: true},
        {name: 'contradiction_type', fieldType: 'select'},
        {name: 'claim_refs', fieldType: 'text'},
        {name: 'event_refs', fieldType: 'text'},
        {name: 'relationship_refs', fieldType: 'text'},
        {name: 'summary', fieldType: 'text', isRequired: true},
        {name: 'severity', fieldType: 'select'},
        {name: 'suggested_resolution', fieldType: 'text'},
        {name: 'review_status', fieldType: 'select'},
        {name: 'resolved_by', fieldType: 'text'},
        {name: 'resolved_at', fieldType: 'date'},
      ];
  }
}

export function summarizeEvidenceDiff(plan: Record<string, unknown> | undefined): EvidenceDiffSummary {
  const summary = {...EMPTY_EVIDENCE_DIFF_SUMMARY};
  const operations = Array.isArray(plan?.proposedOperations)
    ? plan.proposedOperations as Array<Record<string, unknown>>
    : [];
  summary.operations = operations.length;

  for (const operation of operations) {
    const fields = operation.fields && typeof operation.fields === 'object'
      ? operation.fields as Record<string, unknown>
      : {};
    const kind = classifyEvidenceOperation(fields, String(operation.template ?? plan?.template ?? '').toLowerCase());
    incrementSummary(summary, kind);
  }

  return summary;
}

function incrementSummary(summary: EvidenceDiffSummary, template: string): void {
  switch (template) {
    case 'evidence_sources':
      summary.sources += 1;
      break;
    case 'evidence_source_fragments':
      summary.sourceFragments += 1;
      break;
    case 'evidence_claims':
      summary.claims += 1;
      break;
    case 'evidence_people':
      summary.people += 1;
      break;
    case 'evidence_organizations':
      summary.organizations += 1;
      break;
    case 'evidence_places':
      summary.places += 1;
      break;
    case 'evidence_artifacts':
      summary.artifacts += 1;
      break;
    case 'evidence_events':
      summary.events += 1;
      break;
    case 'evidence_relationships':
      summary.relationships += 1;
      break;
    case 'evidence_contradictions':
      summary.contradictions += 1;
      break;
    default:
      break;
  }
}

export function buildEvidenceProjectionPreview(plan: Record<string, unknown> | undefined): EvidenceProjectionPreview {
  const preview: EvidenceProjectionPreview = {
    nodes: [],
    edges: [],
    timelineFacts: [],
    relationshipClaims: [],
    contradictionRadar: [],
    sourceRowExplanations: [],
  };
  const operations = Array.isArray(plan?.proposedOperations)
    ? plan.proposedOperations as Array<Record<string, unknown>>
    : [];

  operations.forEach((operation, index) => {
    const fields = operation.fields && typeof operation.fields === 'object'
      ? operation.fields as Record<string, unknown>
      : {};
    const rowNumber = operation.rowNumber ?? index + 1;
    const kind = classifyEvidenceOperation(fields, String(operation.template ?? plan?.template ?? '').toLowerCase());
    const explanation: Record<string, unknown> = {
      rowNumber,
      operation: operation.op ?? operation.action ?? 'row.propose',
      kind,
      creates: [],
      links: [],
      projection: null,
      reviewRequired: true,
    };

    if (kind === 'evidence_sources') {
      const sourceId = stringValue(fields.source_id);
      if (sourceId) {
        const node = {
          id: `source:${sourceId}`,
          type: 'source',
          label: fields.title ?? sourceId,
          sourceId,
        };
        preview.nodes.push(node);
        (explanation.creates as unknown[]).push(node.id);
      }
    }

    if (kind === 'evidence_source_fragments') {
      const fragmentId = stringValue(fields.fragment_id);
      const sourceRef = stringValue(fields.source_ref);
      if (fragmentId) {
        const node = {
          id: `source_fragment:${fragmentId}`,
          type: 'source_fragment',
          label: fields.locator ?? fields.quote_or_text ?? fragmentId,
          fragmentId,
          sourceRef,
        };
        preview.nodes.push(node);
        (explanation.creates as unknown[]).push(node.id);
      }
      if (fragmentId && sourceRef) {
        const edge = {from: `source:${sourceRef}`, to: `source_fragment:${fragmentId}`, type: 'contains_fragment'};
        preview.edges.push(edge);
        (explanation.links as unknown[]).push(edge);
      }
    }

    if (kind === 'evidence_claims') {
      const claimId = stringValue(fields.claim_id);
      if (claimId) {
        const node = {
          id: `claim:${claimId}`,
          type: 'claim',
          label: fields.claim_text ?? claimId,
          claimId,
          reviewStatus: fields.review_status,
          projectionStatus: fields.projection_status,
          sourceRefs: refs(fields.source_ref, fields.source_refs),
          sourceFragmentRefs: refs(fields.source_fragment_ref, fields.source_fragment_refs),
        };
        preview.nodes.push(node);
        (explanation.creates as unknown[]).push(node.id);
        for (const sourceRef of refs(fields.source_ref, fields.source_refs)) {
          const edge = {from: `source:${sourceRef}`, to: node.id, type: String(fields.evidence_role ?? 'supports')};
          preview.edges.push(edge);
          (explanation.links as unknown[]).push(edge);
        }
        for (const fragmentRef of refs(fields.source_fragment_ref, fields.source_fragment_refs)) {
          const edge = {from: `source_fragment:${fragmentRef}`, to: node.id, type: String(fields.evidence_role ?? 'supports')};
          preview.edges.push(edge);
          (explanation.links as unknown[]).push(edge);
        }
      }
    }

    if (kind === 'evidence_events') {
      const eventId = stringValue(fields.event_id);
      if (eventId) {
        const fact = {
          id: `temporal_fact:${eventId}`,
          eventId,
          title: fields.title ?? eventId,
          eventType: fields.event_type,
          timeStart: fields.time_start,
          timeEnd: fields.time_end,
          timePrecision: fields.time_precision,
          claimRefs: refs(fields.claim_refs),
          sourceRefs: refs(fields.source_refs),
          reviewStatus: fields.review_status,
          projectionStatus: fields.projection_status,
          confidence: fields.confidence,
        };
        preview.timelineFacts.push(fact);
        (explanation.creates as unknown[]).push(fact.id);
        explanation.projection = 'timeline_fact';
        for (const claimRef of fact.claimRefs as string[]) {
          const edge = {from: `claim:${claimRef}`, to: fact.id, type: 'projects_to_event'};
          preview.edges.push(edge);
          (explanation.links as unknown[]).push(edge);
        }
      }
    }

    if (kind === 'evidence_relationships') {
      const relationshipId = stringValue(fields.relationship_id);
      if (relationshipId) {
        const relationship = {
          id: `relationship_claim:${relationshipId}`,
          relationshipId,
          relationshipType: fields.relationship_type,
          subjectRef: fields.subject_ref,
          objectRef: fields.object_ref,
          timeStart: fields.time_start,
          timeEnd: fields.time_end,
          claimRefs: refs(fields.claim_refs),
          sourceRefs: refs(fields.source_refs),
          reviewStatus: fields.review_status,
          projectionStatus: fields.projection_status,
          confidence: fields.confidence,
        };
        preview.relationshipClaims.push(relationship);
        (explanation.creates as unknown[]).push(relationship.id);
        explanation.projection = 'relationship_claim';
        if (fields.subject_ref && fields.object_ref) {
          const edge = {
            from: String(fields.subject_ref),
            to: String(fields.object_ref),
            type: String(fields.relationship_type ?? 'relationship_claim'),
            evidence: relationship.id,
          };
          preview.edges.push(edge);
          (explanation.links as unknown[]).push(edge);
        }
      }
    }

    if (kind === 'evidence_contradictions') {
      const contradictionId = stringValue(fields.contradiction_id);
      if (contradictionId) {
        const contradiction = {
          id: `contradiction:${contradictionId}`,
          contradictionId,
          contradictionType: fields.contradiction_type,
          claimRefs: refs(fields.claim_refs),
          eventRefs: refs(fields.event_refs),
          relationshipRefs: refs(fields.relationship_refs),
          summary: fields.summary,
          reviewStatus: fields.review_status,
          severity: fields.severity,
        };
        preview.contradictionRadar.push(contradiction);
        (explanation.creates as unknown[]).push(contradiction.id);
        explanation.projection = 'contradiction_radar';
      }
    }

    preview.sourceRowExplanations.push(explanation);
  });

  return preview;
}

function classifyEvidenceOperation(fields: Record<string, unknown>, template: string): string {
  if (template.startsWith('evidence_')) return template;
  const names = new Set(Object.keys(fields));
  if (names.has('source_id')) return 'evidence_sources';
  if (names.has('fragment_id')) return 'evidence_source_fragments';
  if (names.has('claim_id') || names.has('claim_text')) return 'evidence_claims';
  if (names.has('person_id')) return 'evidence_people';
  if (names.has('organization_id')) return 'evidence_organizations';
  if (names.has('place_id')) return 'evidence_places';
  if (names.has('artifact_id')) return 'evidence_artifacts';
  if (names.has('event_id')) return 'evidence_events';
  if (names.has('relationship_id')) return 'evidence_relationships';
  if (names.has('contradiction_id')) return 'evidence_contradictions';
  return template;
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function refs(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const ref = stringValue(item);
        if (ref) out.push(ref);
      }
      continue;
    }
    if (typeof value === 'string' && value.includes(',')) {
      for (const item of value.split(',')) {
        const ref = stringValue(item);
        if (ref) out.push(ref);
      }
      continue;
    }
    const ref = stringValue(value);
    if (ref) out.push(ref);
  }
  return Array.from(new Set(out));
}
