import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsExport extends BaseCommand {
  static description = 'Export bounded dataset records as CSV, JSON, JSONL, or Markdown';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    filters: Flags.string({description: 'JSON array of filters'}),
    sorts: Flags.string({description: 'JSON array of sorts'}),
    limit: Flags.integer({description: 'Max rows to export', default: 500}),
    format: Flags.string({description: 'Export format', options: ['csv', 'json', 'jsonl', 'markdown'], default: 'csv'}),
    output: Flags.string({description: 'Output file path (writes to stdout if omitted)', char: 'o'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsExport);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {limit: flags.limit};
    if (flags.filters) options.filters = JSON.parse(flags.filters);
    if (flags.sorts) options.sorts = JSON.parse(flags.sorts);

    const response = await client.queryDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    const records = Array.isArray(data?.records) ? data.records : [];
    const rows = records.map((record: any) => ({
      __id: record.id ?? record.__id,
      ...(record.fields ?? record),
    }));
    const formatted = formatRows(rows, flags.format);
    const result = {
      ok: true,
      format: flags.format,
      rowCount: rows.length,
      rows,
      cursor: data?.cursor ?? null,
      output: flags.output ?? null,
    };

    if (flags.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(flags.output, formatted);
      if (!this.jsonEnabled()) {
        this.log(`Exported ${rows.length} rows to ${flags.output}`);
      }
    } else if (!this.jsonEnabled()) {
      this.log(formatted);
    }

    return result;
  }
}

function collectColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return columns;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeCsv(value: unknown): string {
  const text = stringifyCell(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeMarkdown(value: unknown): string {
  return stringifyCell(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatRows(rows: Array<Record<string, unknown>>, format: string): string {
  if (format === 'json') {
    return JSON.stringify(rows, null, 2);
  }
  if (format === 'jsonl') {
    return rows.map((row) => JSON.stringify(row)).join('\n');
  }

  const columns = collectColumns(rows);
  if (columns.length === 0) {
    return '';
  }

  if (format === 'markdown') {
    const header = `| ${columns.map(escapeMarkdown).join(' | ')} |`;
    const separator = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map((row) => `| ${columns.map((column) => escapeMarkdown(row[column])).join(' | ')} |`);
    return [header, separator, ...body].join('\n');
  }

  const header = columns.map(escapeCsv).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','));
  return [header, ...body].join('\n');
}
