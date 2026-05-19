import {renderTable} from './output.js';

export function renderDatasetRecords(records: Record<string, unknown>[], maxFields = 6): void {
  if (records.length === 0) {
    console.log('No records found.');
    return;
  }

  const sampleFields = (records[0]?.fields ?? {}) as Record<string, unknown>;
  const fieldNames = Object.keys(sampleFields);
  const columns = [
    {
      key: 'id',
      header: 'ID',
      get: (row: Record<string, unknown>) => {
        const id = String(row.id ?? '');
        return id.length > 8 ? `${id.slice(0, 8)}...` : id;
      },
    },
    ...fieldNames.slice(0, maxFields).map((name) => ({
      key: name,
      header: name,
      get: (row: Record<string, unknown>) => {
        const fields = row.fields as Record<string, unknown> | undefined;
        const value = fields?.[name];
        const text = value != null ? String(value) : '-';
        return text.length > 30 ? `${text.slice(0, 29)}...` : text;
      },
    })),
  ];

  renderTable(records, columns);
  if (fieldNames.length > maxFields) {
    console.log(`\n(${fieldNames.length - maxFields} more field(s) hidden; use --json for all)`);
  }
}

export function recordKey(record: Record<string, unknown>): string {
  return String(record.id ?? JSON.stringify(record));
}
