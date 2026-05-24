import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('evidence commands', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sift-evidence-'));
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('plans the dataset-backed Company Origin Evidence Graph workflow', async () => {
    const result = await runCommand([
      'evidence',
      'plan',
      'Company Origin Archive',
      '--source-dataset',
      'sources-ds',
      '--project',
      'project-1',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.pack).toBe('company-origin');
    expect(parsed.plan.assumptions).toEqual(expect.arrayContaining([
      'Evidence Graph v1 is dataset-backed; first-class evidence tables are deferred.',
    ]));
    expect(parsed.plan.steps.some((step: any) => step.command.includes('sift evidence extract'))).toBe(true);
    expect(parsed.plan.steps.some((step: any) => step.command.includes('--no-apply'))).toBe(true);
    expect(parsed.plan.verification.join(' ')).toContain('proven');
  });

  it('dry-runs Evidence Graph init without API calls', async () => {
    const result = await runCommand([
      'evidence',
      'init',
      'Company Origin Archive',
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.pack).toBe('company-origin');
    expect(parsed.datasets.map((dataset: any) => dataset.template)).toEqual([
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
    ]);
    expect(parsed.policy.projectionRequiresReview).toBe(true);
  });

  it('creates an Evidence Graph project and dataset-backed working tables after confirmation', async () => {
    const templates = [
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
    ];

    const chain = mockFetch()
      .on('POST', '/api/v1/projects')
      .body((body) => (body as any).name === 'Company Origin Archive')
      .reply(200, {
        project: {id: 'project-1', name: 'Company Origin Archive'},
      });

    for (const template of templates) {
      chain
        .on('POST', '/api/v1/datasets')
        .body((body) => (body as any).metadata?.datasetTemplate === template)
        .reply(200, {dataset: {id: `${template}-ds`, title: `Company Origin Archive ${template}`}});
    }
    chain.install();

    const result = await runCommand([
      'evidence',
      'init',
      'Company Origin Archive',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.project.id).toBe('project-1');
    expect(parsed.datasets).toHaveLength(10);
    expect(parsed.policy.agentsMustNot).toContain('apply_durable_assertions');
  });

  it('dry-runs Evidence Graph source ledger import without applying trusted state', async () => {
    const file = join(dir, 'sources.jsonl');
    writeFileSync(file, '{"source_id":"src-1","title":"Founder memo","source_type":"memo"}\n');

    mockFetch()
      .on('POST', '/api/v1/datasets/sources-ds/import')
      .body((body) => {
        const input = body as any;
        return input.dryRun === true
          && input.upsertBy === 'source_id'
          && input.rows[0].fields.source_id === 'src-1';
      })
      .reply(200, {
        ok: true,
        dryRun: true,
        datasetId: 'sources-ds',
        summary: {create: 1, update: 0, skip: 0, invalid: 0, warning: 0},
        errors: [],
        warnings: [],
      })
      .install();

    const result = await runCommand([
      'evidence',
      'sources',
      'import',
      file,
      '--dataset-id',
      'sources-ds',
      '--dry-run',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.evidence.template).toBe('evidence_sources');
    expect(parsed.evidence.durableAssertionsApplied).toBe(false);
  });

  it('dry-runs Evidence Graph source ledger parsing locally without dataset credentials', async () => {
    const file = join(dir, 'sources.jsonl');
    writeFileSync(file, '{"source_id":"src-1","title":"Founder memo","source_type":"memo","captured_at":"2026-05-23"}\n');

    const result = await runCommand([
      'evidence',
      'sources',
      'import',
      file,
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.datasetId).toBeNull();
    expect(parsed.summary.create).toBe(1);
    expect(parsed.evidence.template).toBe('evidence_sources');
    expect(parsed.evidence.apiCalled).toBe(false);
    expect(parsed.evidence.durableAssertionsApplied).toBe(false);
    expect(parsed.inferredFields.map((field: any) => field.name)).toEqual(expect.arrayContaining([
      'source_id',
      'title',
      'source_type',
    ]));
  });

  it('lists, shows, explains impact, and applies reviewed Evidence Graph diff plans', async () => {
    mockFetch()
      .on('GET', '/api/v1/datasets/diff-plans')
      .query({datasetId: 'claims-ds', status: 'validated', limit: '10'})
      .reply(200, {
        ok: true,
        plans: [{
          id: 'plan-1',
          datasetId: 'claims-ds',
          status: 'validated',
          evidenceGraphProjectId: 'project-1',
          summary: {create: 1},
          createdAt: '2026-05-23T00:00:00.000Z',
        }],
      })
      .on('GET', '/api/v1/datasets/diff-plans/plan-1')
      .reply(200, {
        ok: true,
        plan: {
          id: 'plan-1',
          datasetId: 'claims-ds',
          status: 'validated',
          template: 'evidence_claims',
          proposedOperations: [{
            op: 'row.create',
            rowNumber: 1,
            fields: {
              claim_id: 'claim-1',
              claim_text: 'The company launched in May.',
              source_ref: 'src-1',
            },
          }],
        },
      })
      .on('GET', '/api/v1/datasets/diff-plans/plan-1')
      .reply(200, {
        ok: true,
        plan: {
          id: 'plan-1',
          datasetId: 'claims-ds',
          status: 'validated',
          template: 'evidence_claims',
          proposedOperations: [{
            op: 'row.create',
            rowNumber: 1,
            fields: {
              claim_id: 'claim-1',
              claim_text: 'The company launched in May.',
              source_ref: 'src-1',
            },
          }],
        },
      })
      .on('GET', '/api/v1/datasets/claims-ds/impact')
      .query({planId: 'plan-1'})
      .reply(200, {
        ok: true,
        impactVersion: 'dataset-impact.v1',
        datasetId: 'claims-ds',
        source: {type: 'diff_plan', id: 'plan-1', status: 'validated'},
        changed: {fields: [{name: 'claim_text', type: 'text', resolved: true}], rows: {knownCount: 1}},
        stale: {graph: {stale: true}, formulas: [], views: [], materializedDatasets: [], qualityWarnings: []},
        recommendedActions: [{name: 'review_evidence_projection', reason: 'Claims may affect graph/timeline projection.'}],
        mutates: false,
      })
      .on('POST', '/api/v1/datasets/diff-plans/plan-1/apply')
      .reply(201, {
        ok: true,
        plan: {id: 'plan-1', datasetId: 'claims-ds', status: 'applied', appliedOperationId: 'op-1'},
        result: {
          ok: true,
          dryRun: false,
          datasetId: 'claims-ds',
          summary: {create: 1, update: 0, skip: 0, invalid: 0, warning: 0},
          operationId: 'op-1',
        },
      })
      .install();

    const list = await runCommand([
      'evidence', 'diff', 'list',
      '--dataset-id', 'claims-ds',
      '--project', 'project-1',
      '--status', 'validated',
      '--limit', '10',
      '--json',
      '--token', 'exf_pat_test',
    ]);
    expect(JSON.parse(list.stdout).plans[0].id).toBe('plan-1');

    const show = await runCommand(['evidence', 'diff', 'show', 'plan-1', '--json', '--token', 'exf_pat_test']);
    expect(JSON.parse(show.stdout).evidenceSummary.claims).toBeGreaterThan(0);

    const impact = await runCommand(['evidence', 'diff', 'impact', 'plan-1', '--json', '--token', 'exf_pat_test']);
    const parsedImpact = JSON.parse(impact.stdout);
    expect(parsedImpact.impact.impactVersion).toBe('dataset-impact.v1');
    expect(parsedImpact.projectionPreview.dryRunOnly).toBe(true);
    expect(parsedImpact.projectionPreview.graphStale).toBe(true);

    const applied = await runCommand(['evidence', 'diff', 'apply', 'plan-1', '--yes', '--json', '--token', 'exf_pat_test']);
    const parsedApplied = JSON.parse(applied.stdout);
    expect(parsedApplied.operationId).toBe('op-1');
    expect(parsedApplied.evidence.appliedReviewedDiff).toBe(true);
  });

  it('dry-runs no-apply Evidence Graph extraction work', async () => {
    const result = await runCommand([
      'evidence',
      'extract',
      '--source-dataset',
      'sources-ds',
      '--project',
      'project-1',
      '--targets',
      'claims,events,relationships,contradictions',
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.workItem.inputContext.noApply).toBe(true);
    expect(parsed.workItem.writeScope.noApply).toBe(true);
    expect(parsed.workItem.writeScope.forbidden).toContain('apply_durable_assertions');
    expect(parsed.workItem.verificationCommands.join(' ')).toContain('sift evidence verify');
  });

  it('creates no-apply Evidence Graph extraction work after confirmation', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items')
      .body((body) => {
        const input = body as any;
        return input.assignedAlias === 'researcher'
          && input.projectId === 'project-1'
          && input.inputContext.workflow === 'evidence_graph'
          && input.inputContext.noApply === true
          && input.writeScope.noApply === true
          && input.writeScope.forbidden.includes('merge_identities')
          && input.acceptanceCriteria.length > 0
          && input.verificationCommands.some((command: string) => command.includes('sift evidence proof report'));
      })
      .reply(200, {
        workItem: {id: 'work-1', title: 'Extract Evidence Graph candidates: claims, events'},
      })
      .install();

    const result = await runCommand([
      'evidence',
      'extract',
      '--source-dataset',
      'sources-ds',
      '--project',
      'project-1',
      '--targets',
      'claims,events',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.workItem.id).toBe('work-1');
    expect(parsed.policy.noApply).toBe(true);
  });

  it('dry-runs Evidence Graph projection from a persisted diff plan', async () => {
    mockFetch()
      .on('GET', '/api/v1/datasets/diff-plans/plan-1')
      .reply(200, {
        ok: true,
        plan: {
          id: 'plan-1',
          datasetId: 'claims-ds',
          status: 'validated',
          template: 'evidence_claims',
          proposedOperations: [{
            op: 'row.create',
            rowNumber: 1,
            fields: {
              claim_id: 'claim-1',
              claim_text: 'The company launched in May.',
              source_ref: 'src-1',
            },
          }],
        },
      })
      .on('GET', '/api/v1/datasets/claims-ds/impact')
      .query({planId: 'plan-1'})
      .reply(200, {
        ok: true,
        impactVersion: 'dataset-impact.v1',
        datasetId: 'claims-ds',
        source: {type: 'diff_plan', id: 'plan-1', status: 'validated'},
        changed: {fields: [{name: 'claim_text', type: 'text', resolved: true}], rows: {knownCount: 1}},
        stale: {graph: {stale: true}, formulas: [], views: [], materializedDatasets: [], qualityWarnings: []},
        recommendedActions: [{name: 'sync_graph_projection', reason: 'Graph projection is stale.'}],
        mutates: false,
      })
      .install();

    const result = await runCommand([
      'evidence',
      'project',
      '--project',
      'project-1',
      '--from-plan',
      'plan-1',
      '--dry-run',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.projectionPlanVersion).toBe('evidence-projection.v1');
    expect(parsed.operationPreview.wouldWrite).toBe(false);
    expect(parsed.operationPreview.reviewRequired).toBe(true);
    expect(parsed.warnings.map((warning: any) => warning.code)).toEqual(expect.arrayContaining([
      'graph_projection_stale',
      'review_required',
    ]));
  });

  it('builds typed timeline, relationship, and contradiction projection previews from diff rows', async () => {
    mockFetch()
      .on('GET', '/api/v1/datasets/diff-plans/plan-typed')
      .reply(200, {
        ok: true,
        plan: {
          id: 'plan-typed',
          datasetId: 'evidence-ds',
          status: 'validated',
          proposedOperations: [
            {
              op: 'row.create',
              template: 'evidence_claims',
              rowNumber: 1,
              fields: {
                claim_id: 'claim-launch-may',
                claim_text: 'The company launched publicly in May.',
                source_ref: 'src-founder-memo',
                source_fragment_ref: 'frag-launch-may',
                review_status: 'proposed',
                projection_status: 'proposed',
              },
            },
            {
              op: 'row.create',
              template: 'evidence_events',
              rowNumber: 2,
              fields: {
                event_id: 'event-public-launch',
                title: 'Public launch',
                event_type: 'launch',
                claim_refs: ['claim-launch-may'],
                source_refs: ['src-founder-memo'],
                review_status: 'proposed',
                projection_status: 'proposed',
              },
            },
            {
              op: 'row.create',
              template: 'evidence_relationships',
              rowNumber: 3,
              fields: {
                relationship_id: 'rel-founder-company',
                relationship_type: 'founder',
                subject_ref: 'person:founder',
                object_ref: 'org:company',
                claim_refs: 'claim-launch-may',
                source_refs: 'src-founder-memo',
                review_status: 'proposed',
                projection_status: 'proposed',
              },
            },
            {
              op: 'row.create',
              template: 'evidence_contradictions',
              rowNumber: 4,
              fields: {
                contradiction_id: 'contra-launch-month',
                contradiction_type: 'date_mismatch',
                claim_refs: ['claim-launch-may', 'claim-april-launch'],
                summary: 'April pilot and May public launch need review.',
                review_status: 'needs_review',
              },
            },
          ],
        },
      })
      .on('GET', '/api/v1/datasets/evidence-ds/impact')
      .query({planId: 'plan-typed'})
      .reply(200, {
        ok: true,
        impactVersion: 'dataset-impact.v1',
        datasetId: 'evidence-ds',
        changed: {fields: [], rows: {knownCount: 4}},
        stale: {graph: {stale: false}, formulas: [], views: [], materializedDatasets: [], qualityWarnings: []},
        recommendedActions: [],
        mutates: false,
      })
      .install();

    const result = await runCommand([
      'evidence',
      'project',
      '--project',
      'project-1',
      '--from-plan',
      'plan-typed',
      '--dry-run',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.evidenceSummary).toMatchObject({
      claims: 1,
      events: 1,
      relationships: 1,
      contradictions: 1,
      operations: 4,
    });
    expect(parsed.timelineFacts).toHaveLength(1);
    expect(parsed.timelineFacts[0]).toMatchObject({
      id: 'temporal_fact:event-public-launch',
      eventId: 'event-public-launch',
      claimRefs: ['claim-launch-may'],
      sourceRefs: ['src-founder-memo'],
    });
    expect(parsed.relationshipClaims).toHaveLength(1);
    expect(parsed.relationshipClaims[0]).toMatchObject({
      id: 'relationship_claim:rel-founder-company',
      subjectRef: 'person:founder',
      objectRef: 'org:company',
      claimRefs: ['claim-launch-may'],
    });
    expect(parsed.contradictionRadar).toHaveLength(1);
    expect(parsed.contradictionRadar[0].claimRefs).toEqual(['claim-launch-may', 'claim-april-launch']);
    expect(parsed.sourceRowExplanations).toHaveLength(4);
    expect(parsed.edges.map((edge: any) => edge.type)).toEqual(expect.arrayContaining([
      'supports',
      'projects_to_event',
      'founder',
    ]));
  });

  it('dry-runs typed Evidence Graph projection from a local diff plan file without API access', async () => {
    const planFile = join(dir, 'evidence-plan.json');
    writeFileSync(planFile, JSON.stringify({
      id: 'plan-local',
      datasetId: 'evidence-ds',
      status: 'validated',
      proposedOperations: [
        {
          op: 'row.create',
          template: 'evidence_events',
          rowNumber: 1,
          fields: {
            event_id: 'event-public-launch',
            title: 'Public launch',
            claim_refs: ['claim-launch-may'],
            source_refs: ['src-founder-memo'],
            review_status: 'proposed',
            projection_status: 'proposed',
          },
        },
      ],
    }));

    const result = await runCommand([
      'evidence',
      'project',
      '--project',
      'project-1',
      '--from-file',
      planFile,
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.source.type).toBe('diff_plan_file');
    expect(parsed.operationPreview.wouldWrite).toBe(false);
    expect(parsed.timelineFacts).toHaveLength(1);
    expect(parsed.timelineFacts[0].id).toBe('temporal_fact:event-public-launch');
  });

  it('verifies an Evidence Graph packet and generates JSON and Markdown proof reports', async () => {
    const packet = join(dir, 'packet.json');
    writeFileSync(packet, JSON.stringify({
      project: {id: 'project-1', name: 'Company Origin Archive'},
      sources: [{source_id: 'src-1', title: 'Founder memo'}],
      fragments: [{fragment_id: 'frag-1', source_ref: 'src-1', quote_or_text: 'We launched in May.'}],
      claims: [
        {
          claim_id: 'claim-1',
          claim_text: 'The company launched in May.',
          claim_status: 'accepted',
          source_ref: 'src-1',
          source_fragment_ref: 'frag-1',
        },
        {
          claim_id: 'claim-2',
          claim_text: 'The launch date may have been April.',
          claim_status: 'contradicted',
          source_ref: 'src-1',
        },
      ],
      events: [{
        event_id: 'event-1',
        title: 'Company launch',
        projection_status: 'projected',
        claim_refs: ['claim-1'],
        source_refs: ['src-1'],
      }],
      relationships: [{
        relationship_id: 'rel-1',
        relationship_type: 'founder',
        subject_ref: 'person:founder',
        object_ref: 'org:company',
        projection_status: 'projected',
        claim_refs: ['claim-1'],
      }],
      contradictions: [{
        contradiction_id: 'contra-1',
        contradiction_type: 'date_mismatch',
        summary: 'Launch month differs across sources.',
        review_status: 'needs_review',
      }],
      diffPlans: [{id: 'plan-1'}],
      operations: [{id: 'op-1'}],
      projection: {projectionPlanVersion: 'evidence-projection.v1'},
      narrative: {
        paragraphs: [{
          text: 'The company launch is supported by the founder memo.',
          factual: true,
          citations: ['claim-1', 'src-1'],
        }],
      },
    }));

    const verify = await runCommand(['evidence', 'verify', '--from-file', packet, '--json']);
    const parsedVerify = JSON.parse(verify.stdout);
    expect(parsedVerify.ok).toBe(true);
    expect(parsedVerify.verification.summary.sources).toBe(1);
    expect(parsedVerify.verification.summary.diffPlans).toBe(1);

    const proofJson = await runCommand(['evidence', 'proof', 'report', '--from-file', packet, '--format', 'json', '--json']);
    const parsedProof = JSON.parse(proofJson.stdout);
    expect(parsedProof.ok).toBe(true);
    expect(parsedProof.reportVersion).toBe('evidence-proof.v1');
    expect(parsedProof.reproducibility.diffPlanIds).toEqual(['plan-1']);
    expect(parsedProof.reproducibility.operationIds).toEqual(['op-1']);
    expect(parsedProof.claims.proven[0].claim_id).toBe('claim-1');

    const proofMarkdown = await runCommand(['evidence', 'proof', 'report', '--from-file', packet, '--format', 'markdown']);
    expect(proofMarkdown.stdout).toContain('# Evidence Graph Proof Report');
    expect(proofMarkdown.stdout).toContain('diff plan ids: plan-1');
    expect(proofMarkdown.stdout).toContain('operation ids: op-1');
    expect(proofMarkdown.stdout).toContain('[claim-1, src-1]');
  });

  it('fails verification for unsupported accepted facts and uncited factual narrative', async () => {
    const packet = join(dir, 'bad-packet.json');
    writeFileSync(packet, JSON.stringify({
      claims: [{claim_id: 'claim-1', claim_text: 'Unsupported claim', claim_status: 'accepted'}],
      events: [{event_id: 'event-1', title: 'Unsupported event', projection_status: 'projected'}],
      relationships: [{relationship_id: 'rel-1', projection_status: 'projected'}],
      narrative: {paragraphs: [{text: 'A factual uncited sentence.', factual: true}]},
    }));

    const verify = await runCommand(['evidence', 'verify', '--from-file', packet, '--json']);
    const parsed = JSON.parse(verify.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.verification.findings.map((finding: any) => finding.code)).toEqual(expect.arrayContaining([
      'accepted_claim_missing_provenance',
      'projected_event_missing_evidence',
      'projected_relationship_missing_evidence',
      'factual_narrative_missing_citation',
    ]));
  });
});
