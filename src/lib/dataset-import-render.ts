import {renderDetail, renderTable} from './output.js';

export function renderDatasetImportResult(result: Record<string, unknown>): void {
  const summary = (result.summary ?? {}) as Record<string, unknown>;
  renderDetail([
    ['Dataset ID', result.datasetId],
    ['Dry run', result.dryRun],
    ['Template', result.template],
    ['Upsert by', result.upsertBy],
    ['Create', summary.create],
    ['Update', summary.update],
    ['Skip', summary.skip],
    ['Invalid', summary.invalid],
    ['Warnings', summary.warning],
  ]);

  const issues = [
    ...((result.errors ?? []) as Record<string, unknown>[]),
    ...((result.warnings ?? []) as Record<string, unknown>[]),
  ];
  if (issues.length > 0) {
    console.log('');
    renderTable(issues, [
      {key: 'severity', header: 'Severity'},
      {key: 'type', header: 'Type'},
      {key: 'row', header: 'Row'},
      {key: 'field', header: 'Field'},
      {key: 'message', header: 'Message'},
    ]);
  }
}
