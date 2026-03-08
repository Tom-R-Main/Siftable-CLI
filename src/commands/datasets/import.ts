import {Args, Flags} from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsImport extends BaseCommand {
  static description = 'Import a CSV file into a new or existing dataset';

  static args = {
    file: Args.string({description: 'Path to CSV file', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Dataset title (defaults to filename)'}),
    description: Flags.string({description: 'Dataset description'}),
    'dataset-id': Flags.string({description: 'Append to existing dataset instead of creating new'}),
    'batch-size': Flags.integer({description: 'Records per batch', default: 50}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsImport);
    const client = await this.client(flags);

    if (!fs.existsSync(args.file)) {
      this.error(`File not found: ${args.file}`);
    }

    const text = fs.readFileSync(args.file, 'utf8');
    const {headers, rows} = this.parseCSV(text);

    if (rows.length === 0) {
      this.error('CSV file has no data rows.');
    }

    this.log(`Parsed: ${rows.length} rows, ${headers.length} columns`);

    // Infer schema from sample data
    const fields = headers.map(name => ({
      name,
      type: this.inferFieldType(rows.slice(0, 100).map(r => r[headers.indexOf(name)] ?? '')),
    }));

    let datasetId = flags['dataset-id'];

    if (!datasetId) {
      const title = flags.title || path.basename(args.file, path.extname(args.file));
      const description = flags.description || `Imported from ${path.basename(args.file)}`;

      this.log(`Creating dataset: "${title}"…`);
      const createResp = await client.createDataset({title, description, fields});
      this.handleApiError(createResp);
      const dataset = this.unwrapOne(createResp, 'dataset');
      datasetId = dataset.id as string;
      this.log(`Created: ${datasetId}`);
    }

    // Build records
    const records = rows.map(row => {
      const fieldMap: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        fieldMap[h] = row[i] ?? '';
      });
      return {fields: fieldMap};
    });

    // Batch insert
    const batchSize = flags['batch-size'];
    let inserted = 0;

    this.log(`Inserting ${records.length} records…`);

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const resp = await client.mutateDataset(datasetId, {
        operation: 'create',
        records: batch,
      });
      this.handleApiError(resp);
      inserted += batch.length;

      if (!this.jsonEnabled()) {
        process.stderr.write(`  ${inserted}/${records.length}\r`);
      }
    }

    if (!this.jsonEnabled()) {
      this.log(`Inserted ${inserted} records into ${datasetId}`);
    }

    // Return summary
    const summaryResp = await client.summarizeDataset(datasetId);
    if (!summaryResp.error) {
      const summary = this.unwrapOne(summaryResp, 'summary');
      if (!this.jsonEnabled()) {
        this.log(`Dataset: ${summary.title} — ${summary.rowCount} rows, ${summary.fieldCount} fields`);
      }
    }

    return {datasetId, inserted, total: records.length};
  }

  private parseCSV(text: string): {headers: string[]; rows: string[][]} {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows: string[][] = [];
    let i = 0;

    while (i < text.length) {
      const row: string[] = [];
      while (i < text.length) {
        if (text[i] === '"') {
          i++;
          let field = '';
          while (i < text.length) {
            if (text[i] === '"') {
              if (text[i + 1] === '"') {
                field += '"';
                i += 2;
              } else {
                i++;
                break;
              }
            } else {
              field += text[i];
              i++;
            }
          }
          row.push(field);
          if (text[i] === ',') i++;
          else if (text[i] === '\n' || i >= text.length) { i++; break; }
        } else {
          let field = '';
          while (i < text.length && text[i] !== ',' && text[i] !== '\n') {
            field += text[i];
            i++;
          }
          row.push(field);
          if (text[i] === ',') i++;
          else { i++; break; }
        }
      }
      if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
        rows.push(row);
      }
    }

    const headers = (rows[0] ?? []).map(h => h.trim());
    return {headers, rows: rows.slice(1)};
  }

  private inferFieldType(values: string[]): string {
    let nums = 0;
    let total = 0;
    for (const v of values) {
      if (v === '' || v == null) continue;
      total++;
      if (!isNaN(Number(v)) && v.trim() !== '') nums++;
    }
    if (total === 0) return 'text';
    return nums / total > 0.8 ? 'number' : 'text';
  }
}
