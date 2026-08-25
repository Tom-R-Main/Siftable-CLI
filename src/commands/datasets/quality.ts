import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable, sanitizeTerminalText} from '../../lib/output.js';

interface QualityExample {
  value: string;
  occurrences?: number;
}

interface QualityFinding {
  classification: 'issue' | 'observation';
  severity: 'note' | 'warn';
  message: string;
  examples?: QualityExample[];
}

interface QualityField {
  field: string;
  fieldType: string;
  totalRows: number;
  missingCount: number;
  missingRate: number;
  nonMissingCount: number;
  distinctCount: number;
  findings: QualityFinding[];
}

interface DatasetQualityResult {
  contractVersion: 1;
  datasetId: string;
  title: string;
  totalRows: number;
  fieldCount: number;
  summary: {issueCount: number; warningCount: number; observationCount: number};
  fields: QualityField[];
  generatedAt: string;
}

export default class DatasetsQuality extends BaseCommand {
  static description = 'Check dataset quality with structured missing-value metrics and repeated-value observations';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fields: Flags.string({description: 'Comma-separated field names to check'}),
    'repeat-threshold': Flags.integer({
      description: 'Minimum occurrences for a repeated value to be reported',
      default: 3,
      min: 2,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsQuality);
    const client = await this.client(flags);
    // The CLI and MCP packages are independently publishable, so tolerate an
    // installed MCP client declaration that predates the preferred input name.
    const checkQuality = client.checkDatasetQuality.bind(client) as (
      datasetId: string,
      options: {fields?: string[]; repeatThreshold?: number},
    ) => ReturnType<typeof client.checkDatasetQuality>;
    const response = await checkQuality(args.id, {
      fields: flags.fields?.split(',').map(field => field.trim()).filter(Boolean),
      repeatThreshold: flags['repeat-threshold'],
    });
    this.handleApiError(response);
    const data = response.data as DatasetQualityResult;
    const result: DatasetQualityResult = {
      contractVersion: 1,
      datasetId: data.datasetId,
      title: data.title,
      totalRows: data.totalRows,
      fieldCount: data.fieldCount,
      summary: data.summary,
      fields: data.fields.map(field => ({
        field: field.field,
        fieldType: field.fieldType,
        totalRows: field.totalRows,
        missingCount: field.missingCount,
        missingRate: field.missingRate,
        nonMissingCount: field.nonMissingCount,
        distinctCount: field.distinctCount,
        findings: field.findings,
      })),
      generatedAt: data.generatedAt,
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset', `${result.title} (${result.datasetId})`],
        ['Rows', result.totalRows],
        ['Fields checked', result.fieldCount],
        ['Issues', result.summary.issueCount],
        ['Warnings', result.summary.warningCount],
        ['Observations', result.summary.observationCount],
      ]);

      this.log('');
      renderTable(result.fields.map(field => ({
        field: field.field,
        type: field.fieldType,
        missing: `${field.missingCount}/${field.totalRows} (${Math.round(field.missingRate * 100)}%)`,
        distinct: field.distinctCount,
        status: field.findings.some(finding => finding.severity === 'warn')
          ? 'WARN'
          : field.findings.length > 0 ? 'NOTE' : 'OK',
      })), [
        {key: 'field', header: 'Field'},
        {key: 'type', header: 'Type'},
        {key: 'missing', header: 'Missing'},
        {key: 'distinct', header: 'Distinct'},
        {key: 'status', header: 'Status'},
      ]);

      const findings = result.fields.flatMap(field =>
        field.findings.map(finding => ({field: field.field, finding})),
      );
      if (findings.length > 0) {
        this.log('\nFindings:');
        for (const {field, finding} of findings) {
          const label = finding.classification === 'observation' ? 'OBSERVATION' : finding.severity.toUpperCase();
          this.log(`  [${label}] ${sanitizeTerminalText(field)}: ${sanitizeTerminalText(finding.message)}`);
          if (finding.examples && finding.examples.length > 0) {
            const examples = finding.examples.map(example =>
              example.occurrences === undefined
                ? `"${sanitizeTerminalText(example.value)}"`
                : `"${sanitizeTerminalText(example.value)}" (${example.occurrences}x)`,
            );
            this.log(`    Examples: ${examples.join(', ')}`);
          }
        }
      }
    }

    return result;
  }
}
