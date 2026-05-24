import {Flags} from '@oclif/core';
import {readFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {EVIDENCE_PACKS, EvidencePack, buildEvidenceProjectionPreview, summarizeEvidenceDiff} from '../../lib/evidence.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class EvidenceProject extends BaseCommand {
  static description = 'Dry-run Evidence Graph timeline and relationship projection';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Evidence Graph project ID'}),
    pack: Flags.string({description: 'Evidence workflow pack', options: [...EVIDENCE_PACKS], default: 'company-origin'}),
    'from-plan': Flags.string({description: 'Persisted diff plan ID to project from'}),
    'from-file': Flags.string({description: 'Local diff plan JSON file to project from without API access'}),
    'dry-run': Flags.boolean({description: 'Preview projection without writing', default: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EvidenceProject);
    if (!flags['dry-run']) {
      this.error('Evidence projection is dry-run only in v1. Apply reviewed diffs first, then verify before trusting projections.');
    }

    if (flags['from-plan'] && flags['from-file']) {
      this.error('Provide either --from-plan or --from-file, not both.');
    }

    if (!flags['from-plan'] && !flags['from-file']) {
      const result = {
        ok: true,
        dryRun: true,
        projectionPlanVersion: 'evidence-projection.v1',
        pack: flags.pack as EvidencePack,
        projectId: flags.project,
        nodes: [],
        edges: [],
        timelineFacts: [],
        relationshipClaims: [],
        blockers: [{
          code: 'diff_plan_required',
          message: 'Provide --from-plan <diff-plan-id> to preview concrete projection consequences.',
        }],
        warnings: [],
        operationPreview: null,
      };
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Projection', result.projectionPlanVersion],
          ['Dry run', 'yes'],
          ['Blockers', result.blockers.length],
        ]);
      }
      return result;
    }

    if (flags['from-file']) {
      const plan = readLocalDiffPlan(flags['from-file']);
      const evidenceSummary = summarizeEvidenceDiff(plan);
      const projectionPreview = buildEvidenceProjectionPreview(plan);
      const result = {
        ok: true,
        dryRun: true,
        projectionPlanVersion: 'evidence-projection.v1',
        pack: flags.pack as EvidencePack,
        projectId: flags.project,
        source: {
          type: 'diff_plan_file',
          path: flags['from-file'],
          datasetId: plan.datasetId,
          status: plan.status,
        },
        evidenceSummary,
        nodes: projectionPreview.nodes,
        edges: projectionPreview.edges,
        timelineFacts: projectionPreview.timelineFacts,
        relationshipClaims: projectionPreview.relationshipClaims,
        contradictionRadar: projectionPreview.contradictionRadar,
        sourceRowExplanations: projectionPreview.sourceRowExplanations,
        blockers: [],
        warnings: buildProjectionWarnings(evidenceSummary, {}),
        operationPreview: {
          wouldWrite: false,
          reviewRequired: true,
          knownRows: evidenceSummary.operations,
          graphStale: false,
          recommendedActions: [{
            name: 'review_local_evidence_projection',
            reason: 'Local diff plan projection is a dry-run preview; persist/review the plan before applying trusted state.',
          }],
        },
        impact: null,
      };

      if (!this.jsonEnabled()) {
        renderDetail([
          ['Projection', result.projectionPlanVersion],
          ['Diff plan file', flags['from-file']],
          ['Dry run', 'yes'],
          ['Operations', evidenceSummary.operations],
          ['Timeline facts', result.timelineFacts.length],
          ['Relationship claims', result.relationshipClaims.length],
          ['Contradictions', result.contradictionRadar.length],
        ]);
      }
      return result;
    }

    const client = await this.client(flags);
    const planId = flags['from-plan']!;
    const planResponse = await client.getDatasetDiffPlan(planId);
    this.handleApiError(planResponse);
    const planResult = planResponse.data as {ok: true; plan: Record<string, unknown>};
    const datasetId = String(planResult.plan.datasetId ?? '');
    if (!datasetId) {
      this.error(`Diff plan ${planId} does not include a datasetId.`);
    }

    const impactResponse = await client.getDatasetImpact(datasetId, {planId});
    this.handleApiError(impactResponse);
    const impact = impactResponse.data as Record<string, any>;
    const evidenceSummary = summarizeEvidenceDiff(planResult.plan);
    const projectionPreview = buildEvidenceProjectionPreview(planResult.plan);
    const result = {
      ok: true,
      dryRun: true,
      projectionPlanVersion: 'evidence-projection.v1',
      pack: flags.pack as EvidencePack,
      projectId: flags.project,
      source: {
        type: 'diff_plan',
        id: planId,
        datasetId,
        status: planResult.plan.status,
      },
      evidenceSummary,
      nodes: projectionPreview.nodes,
      edges: projectionPreview.edges,
      timelineFacts: projectionPreview.timelineFacts,
      relationshipClaims: projectionPreview.relationshipClaims,
      contradictionRadar: projectionPreview.contradictionRadar,
      sourceRowExplanations: projectionPreview.sourceRowExplanations,
      blockers: [],
      warnings: buildProjectionWarnings(evidenceSummary, impact),
      operationPreview: {
        wouldWrite: false,
        reviewRequired: true,
        changedFields: impact.changed?.fields ?? [],
        knownRows: impact.changed?.rows?.knownCount ?? 0,
        graphStale: Boolean(impact.stale?.graph?.stale),
        recommendedActions: impact.recommendedActions ?? [],
      },
      impact,
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Projection', result.projectionPlanVersion],
        ['Plan ID', planId],
        ['Dataset ID', datasetId],
        ['Dry run', 'yes'],
        ['Operations', evidenceSummary.operations],
        ['Warnings', result.warnings.length],
      ]);
      const actions = Array.isArray(result.operationPreview.recommendedActions)
        ? result.operationPreview.recommendedActions as Record<string, unknown>[]
        : [];
      if (actions.length > 0) {
        this.log('');
        renderTable(actions, [
          {key: 'name', header: 'Next Action'},
          {key: 'reason', header: 'Reason'},
        ]);
      }
    }

    return result;
  }
}

function readLocalDiffPlan(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (parsed.plan && typeof parsed.plan === 'object') {
      return parsed.plan as Record<string, unknown>;
    }
    return parsed;
  } catch (error) {
    throw new Error(error instanceof Error ? `Failed to read diff plan file: ${error.message}` : 'Failed to read diff plan file.');
  }
}

function buildProjectionWarnings(evidenceSummary: ReturnType<typeof summarizeEvidenceDiff>, impact: Record<string, any>): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  if (evidenceSummary.operations === 0) {
    warnings.push({
      code: 'no_operations',
      message: 'Diff plan contains no proposed operations to project.',
    });
  }
  if (impact.stale?.graph?.stale) {
    warnings.push({
      code: 'graph_projection_stale',
      message: 'Dataset impact reports stale graph projection for affected rows.',
    });
  }
  if (evidenceSummary.claims > 0 || evidenceSummary.events > 0 || evidenceSummary.relationships > 0) {
    warnings.push({
      code: 'review_required',
      message: 'Claims, events, and relationships must remain review-gated before trusted projection.',
    });
  }
  return warnings;
}
