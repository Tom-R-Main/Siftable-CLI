import {Args, Flags} from '@oclif/core';
import {readFileSync} from 'node:fs';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';
import {buildEvidenceProjectionPreview, summarizeEvidenceDiff} from '../../../lib/evidence.js';

export default class EvidenceDiffImpact extends BaseCommand {
  static description = 'Explain Evidence Graph consequences for a persisted diff plan';

  static args = {
    id: Args.string({description: 'Persisted diff plan ID, or local when using --from-file', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'from-file': Flags.string({description: 'Local diff plan JSON file to explain without API access'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceDiffImpact);
    if (flags['from-file']) {
      const plan = readLocalDiffPlan(flags['from-file']);
      const evidenceSummary = summarizeEvidenceDiff(plan);
      const projection = buildEvidenceProjectionPreview(plan);
      const output = {
        ok: true,
        plan,
        impact: {
          impactVersion: 'evidence-impact.local.v1',
          datasetId: plan.datasetId ?? null,
          source: {
            type: 'diff_plan_file',
            path: flags['from-file'],
            status: plan.status ?? null,
          },
          changed: {
            evidence: evidenceSummary,
            rows: {knownCount: evidenceSummary.operations},
          },
          mutates: false,
        },
        evidenceSummary,
        projectionPreview: {
          dryRunOnly: true,
          graphStale: false,
          semanticConsequences: buildSemanticConsequences(evidenceSummary),
          timelineFacts: projection.timelineFacts,
          relationshipClaims: projection.relationshipClaims,
          contradictionRadar: projection.contradictionRadar,
          sourceRowExplanations: projection.sourceRowExplanations,
          recommendedActions: [{
            name: 'review_local_evidence_projection',
            reason: 'Local diff plan impact is a dry-run preview; apply only after human review.',
          }],
        },
      };

      if (!this.jsonEnabled()) {
        renderDetail([
          ['Plan ID', String(plan.id ?? 'local')],
          ['Dataset ID', String(plan.datasetId ?? '')],
          ['Impact', output.impact.impactVersion],
          ['Evidence operations', evidenceSummary.operations],
          ['Graph stale', 'no'],
        ]);
        this.log('');
        renderTable(output.projectionPreview.semanticConsequences, [
          {key: 'label', header: 'Consequence'},
          {key: 'count', header: 'Count'},
        ]);
      }

      return output;
    }

    const client = await this.client(flags);
    const planResponse = await client.getDatasetDiffPlan(args.id!);
    this.handleApiError(planResponse);
    const planResult = planResponse.data as {ok: true; plan: Record<string, unknown>};
    const datasetId = String(planResult.plan.datasetId ?? '');
    if (!datasetId) {
      this.error(`Diff plan ${args.id!} does not include a datasetId.`);
    }

    const impactResponse = await client.getDatasetImpact(datasetId, {planId: args.id!});
    this.handleApiError(impactResponse);
    const impact = impactResponse.data as Record<string, unknown>;
    const evidenceSummary = summarizeEvidenceDiff(planResult.plan);
    const projection = buildEvidenceProjectionPreview(planResult.plan);
    const output = {
      ok: true,
      plan: planResult.plan,
      impact,
      evidenceSummary,
      projectionPreview: {
        dryRunOnly: true,
        graphStale: Boolean((impact.stale as Record<string, any> | undefined)?.graph?.stale),
        semanticConsequences: buildSemanticConsequences(evidenceSummary),
        timelineFacts: projection.timelineFacts,
        relationshipClaims: projection.relationshipClaims,
        contradictionRadar: projection.contradictionRadar,
        sourceRowExplanations: projection.sourceRowExplanations,
        recommendedActions: impact.recommendedActions ?? [],
      },
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Plan ID', args.id],
        ['Dataset ID', datasetId],
        ['Impact', String(impact.impactVersion ?? '')],
        ['Evidence operations', evidenceSummary.operations],
        ['Graph stale', output.projectionPreview.graphStale ? 'yes' : 'no'],
      ]);
      const actions = Array.isArray(impact.recommendedActions) ? impact.recommendedActions as Record<string, unknown>[] : [];
      if (actions.length > 0) {
        this.log('');
        renderTable(actions, [
          {key: 'name', header: 'Next Action'},
          {key: 'reason', header: 'Reason'},
        ]);
      }
    }

    return output;
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

function buildSemanticConsequences(summary: ReturnType<typeof summarizeEvidenceDiff>): Array<Record<string, unknown>> {
  return [
    {label: 'Create source', count: summary.sources},
    {label: 'Create fragment', count: summary.sourceFragments},
    {label: 'Propose claim', count: summary.claims},
    {label: 'Project event', count: summary.events},
    {label: 'Project relationship', count: summary.relationships},
    {label: 'Flag contradiction', count: summary.contradictions},
    {label: 'Requires identity review', count: summary.people + summary.organizations},
  ].filter((item) => item.count > 0);
}
