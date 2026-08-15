import {datasetQueryRuntime} from './dataset-query-runtime.js';

export function parseJsonArrayFlag(value: string | undefined, label: string): Array<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed as Array<Record<string, unknown>>;
}

export function parseDatasetFiltersFlag(
  value: string | undefined,
  label = '--filters',
): Array<Record<string, unknown>> | undefined {
  const parsed = parseJsonArrayFlag(value, label);
  if (!parsed) return undefined;
  const issues = datasetQueryRuntime().validateSiftDatasetFilters(parsed, {label});
  if (issues.length > 0) {
    throw new Error(issues.map(issue => issue.message).join('; '));
  }
  return parsed;
}

export function parseDatasetSortsFlag(
  value: string | undefined,
  label = '--sorts',
): Array<Record<string, unknown>> | undefined {
  const parsed = parseJsonArrayFlag(value, label);
  if (!parsed) return undefined;
  const issues = datasetQueryRuntime().validateSiftDatasetSorts(parsed, {label});
  if (issues.length > 0) {
    throw new Error(issues.map(issue => issue.message).join('; '));
  }
  return parsed;
}

export function splitFields(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const fields = value.split(',').map((field) => field.trim()).filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

export function mergeFilters(
  base: Array<Record<string, unknown>> | undefined,
  extra: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [...(base ?? []), extra];
}
