import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable, sanitizeTerminalLine} from '../../lib/output.js';

interface QualityExample {
  value: string;
  occurrences?: number;
}

const DATASET_QUALITY_EXAMPLE_LIMIT = 5;

type QualityFindingCode =
  | 'required_missing_values'
  | 'high_missing_rate'
  | 'non_unique_values'
  | 'invalid_select_values'
  | 'frequent_repeated_values';

interface QualityFinding {
  code: QualityFindingCode;
  classification: 'issue' | 'observation';
  severity: 'note' | 'warn';
  message: string;
  metrics: Record<string, number | boolean>;
  examples?: QualityExample[];
}

interface LegacyQualityIssue {
  severity: 'note' | 'warn';
  message: string;
  examples?: string[];
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
  nullCount?: number;
  nullRate?: number;
  issues?: LegacyQualityIssue[];
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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function qualityFindingCode(value: unknown): QualityFindingCode | null {
  switch (value) {
    case 'required_missing_values':
    case 'high_missing_rate':
    case 'non_unique_values':
    case 'invalid_select_values':
    case 'frequent_repeated_values':
      return value;
    default:
      return null;
  }
}

function normalizeQualityFinding(value: unknown): QualityFinding | null {
  const finding = record(value);
  const code = qualityFindingCode(finding.code);
  const classification = finding.classification;
  const severity = finding.severity;
  const message = finding.message;
  if (
    code === null
    || (classification !== 'issue' && classification !== 'observation')
    || (severity !== 'note' && severity !== 'warn')
    || typeof message !== 'string'
  ) {
    return null;
  }

  const examples = Array.isArray(finding.examples)
    ? finding.examples.flatMap(candidate => {
      const example = record(candidate);
      if (typeof example.value !== 'string') return [];
      const occurrences = integer(example.occurrences);
      return [{
        value: example.value,
        ...(occurrences === null ? {} : {occurrences}),
      }];
    }).slice(0, DATASET_QUALITY_EXAMPLE_LIMIT)
    : [];
  const metrics = Object.fromEntries(
    Object.entries(record(finding.metrics))
      .filter(([, metric]) => typeof metric === 'boolean' || finiteNumber(metric) !== null),
  ) as Record<string, number | boolean>;
  const repeatedValueObservation = code === 'frequent_repeated_values';
  return {
    code,
    classification: repeatedValueObservation ? 'observation' : classification,
    severity: repeatedValueObservation ? 'note' : severity,
    message,
    metrics,
    ...(examples.length === 0 ? {} : {examples}),
  };
}

function normalizeLegacyQualityIssue(value: unknown): QualityFinding | null {
  const issue = record(value);
  const severity = issue.severity;
  const message = issue.message;
  if ((severity !== 'note' && severity !== 'warn') || typeof message !== 'string') return null;

  let code: QualityFindingCode;
  let classification: QualityFinding['classification'] = 'issue';
  let normalizedSeverity: QualityFinding['severity'] = severity;
  let normalizedMessage = message;
  if (message.startsWith('Required field has ')) {
    code = 'required_missing_values';
  } else if (/^\d+% missing /.test(message)) {
    code = 'high_missing_rate';
  } else if (
    message.startsWith('Unique field has duplicate values')
    || message.startsWith('Unique field has repeated values')
  ) {
    code = 'non_unique_values';
  } else if (/^\d+ values? not in allowed options$/.test(message)) {
    code = 'invalid_select_values';
  } else if (/^\d+ duplicate groups? found$/.test(message)) {
    const repeatedCount = Number(message.match(/^\d+/)?.[0] ?? 0);
    code = 'frequent_repeated_values';
    classification = 'observation';
    normalizedSeverity = 'note';
    normalizedMessage = `${repeatedCount} frequently repeated value${repeatedCount === 1 ? '' : 's'} sampled; repetition may be valid and is not treated as a uniqueness violation`;
  } else if (/^\d+ frequently repeated values? sampled(?:;|$)/.test(message)) {
    code = 'frequent_repeated_values';
    classification = 'observation';
    normalizedSeverity = 'note';
  } else {
    return null;
  }

  const examples = Array.isArray(issue.examples)
    ? issue.examples.flatMap(candidate => {
      if (typeof candidate !== 'string') return [];
      const repeated = candidate.match(/^"([\s\S]*)" \((\d+)x\)$/);
      return repeated
        ? [{value: repeated[1], occurrences: Number(repeated[2])}]
        : [{value: candidate}];
    })
    : [];
  const boundedExamples = examples.slice(0, DATASET_QUALITY_EXAMPLE_LIMIT);

  return {
    code,
    classification,
    severity: normalizedSeverity,
    message: normalizedMessage,
    metrics: {},
    ...(boundedExamples.length === 0 ? {} : {examples: boundedExamples}),
  };
}

function normalizeQualityResult(value: unknown, fallbackDatasetId: string): DatasetQualityResult {
  const data = record(value);
  const rawFields = Array.isArray(data.fields) ? data.fields : [];
  const fields: QualityField[] = rawFields.map(candidate => {
    const field = record(candidate);
    const totalRows = integer(field.totalRows) ?? 0;
    const missingCount = integer(field.missingCount) ?? integer(field.nullCount) ?? 0;
    const structuredFindings = Array.isArray(field.findings)
      ? field.findings
        .map(normalizeQualityFinding)
        .filter((finding): finding is QualityFinding => finding !== null)
      : [];
    const legacyFindings = Array.isArray(field.issues)
      ? field.issues
        .map(normalizeLegacyQualityIssue)
        .filter((finding): finding is QualityFinding => finding !== null)
      : [];
    const findings = structuredFindings.length > 0 ? structuredFindings : legacyFindings;
    return {
      field: typeof field.field === 'string' ? field.field : '',
      fieldType: typeof field.fieldType === 'string' ? field.fieldType : 'unknown',
      totalRows,
      missingCount,
      missingRate: finiteNumber(field.missingRate) ?? finiteNumber(field.nullRate) ?? 0,
      nonMissingCount: integer(field.nonMissingCount) ?? Math.max(0, totalRows - missingCount),
      distinctCount: integer(field.distinctCount) ?? 0,
      findings,
    };
  });
  const findings = fields.flatMap(field => field.findings);
  const summary = {
    issueCount: findings.filter(finding => finding.classification === 'issue').length,
    warningCount: findings.filter(finding => finding.severity === 'warn').length,
    observationCount: findings.filter(finding => finding.classification === 'observation').length,
  };

  return {
    contractVersion: 1,
    datasetId: typeof data.datasetId === 'string' ? data.datasetId : fallbackDatasetId,
    title: typeof data.title === 'string' ? data.title : 'Untitled dataset',
    totalRows: integer(data.totalRows) ?? 0,
    fieldCount: integer(data.fieldCount) ?? fields.length,
    summary,
    fields,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : new Date(0).toISOString(),
  };
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
    const result = normalizeQualityResult(response.data, args.id);

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
          this.log(`  [${label}] ${sanitizeTerminalLine(field)}: ${sanitizeTerminalLine(finding.message)}`);
          if (finding.examples && finding.examples.length > 0) {
            const examples = finding.examples.map(example =>
              example.occurrences === undefined
                ? `"${sanitizeTerminalLine(example.value)}"`
                : `"${sanitizeTerminalLine(example.value)}" (${example.occurrences}x)`,
            );
            this.log(`    Examples: ${examples.join(', ')}`);
          }
        }
      }
    }

    return result;
  }
}
