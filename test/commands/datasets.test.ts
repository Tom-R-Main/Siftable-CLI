import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('dataset commands', () => {
  describe('datasets create lifecycle metadata', () => {
    it('tags scratch benchmark datasets with TTL metadata', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets')
        .body((body) => {
          const input = body as any;
          return input.title === 'Scratch'
            && input.metadata.lifecycle.kind === 'scratch'
            && input.metadata.lifecycle.tags.includes('benchmark')
            && input.metadata.lifecycle.tags.includes('scratch')
            && input.metadata.lifecycle.runId === 'run-1'
            && typeof input.metadata.lifecycle.expiresAt === 'string';
        })
        .reply(201, {dataset: {id: 'ds-1', title: 'Scratch'}})
        .install();

      const result = await runCommand([
        'datasets',
        'create',
        '--title',
        'Scratch',
        '--scratch',
        '--tags',
        'benchmark',
        '--run-id',
        'run-1',
        '--ttl',
        '7d',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dataset.id).toBe('ds-1');
    });
  });

  describe('datasets templates', () => {
    it('lists templates as stable JSON', async () => {
      mockFetch()
        .on('GET', '/api/v1/datasets/templates')
        .reply(200, {
          ok: true,
          templates: [{name: 'sources', fieldCount: 10, requiredFields: ['source_id', 'title'], requiredProvenance: false}],
        })
        .install();

      const result = await runCommand(['datasets', 'templates', 'list', '--json', '--token', 'exf_pat_test']);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.templates[0].name).toBe('sources');
    });

    it('shows a template schema', async () => {
      mockFetch()
        .on('GET', '/api/v1/datasets/templates/sources')
        .reply(200, {
          ok: true,
          template: {name: 'sources', fields: [{name: 'source_id', type: 'string', required: true}]},
        })
        .install();

      const result = await runCommand(['datasets', 'templates', 'show', 'sources', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('sources');
      expect(result.stdout).toContain('source_id');
    });
  });

  describe('datasets profile', () => {
    it('renders profile output', async () => {
      mockFetch()
        .on('GET', '/api/v1/datasets/ds-1/profile')
        .query({sampleLimit: '10'})
        .reply(200, {
          ok: true,
          datasetId: 'ds-1',
          rowCount: 2,
          columns: [{name: 'source_id', type: 'text', nullCount: 0}],
          sampleRows: [],
        })
        .install();

      const result = await runCommand(['datasets', 'profile', 'ds-1', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Dataset ID');
      expect(result.stdout).toContain('source_id');
    });
  });

  describe('datasets delete', () => {
    it('requires confirmation in non-interactive mode', async () => {
      const result = await runCommand([
        'datasets',
        'delete',
        'ds-1',
        '--no-input',
        '--token',
        'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('Use --yes');
    });

    it('deletes a dataset through the dataset delete route', async () => {
      mockFetch()
        .on('DELETE', '/api/v1/datasets/ds-1')
        .reply(204, {})
        .install();

      const result = await runCommand([
        'datasets',
        'delete',
        'ds-1',
        '--yes',
        '--json',
        '--token',
        'exf_pat_test',
      ]);

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({ok: true, deleted: true, id: 'ds-1'});
    });
  });

  describe('datasets archive', () => {
    it('requires confirmation in non-interactive mode', async () => {
      const result = await runCommand([
        'datasets',
        'archive',
        'ds-1',
        '--no-input',
        '--token',
        'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('Use --yes');
    });

    it('archives through the dataset archive route', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/archive')
        .reply(200, {ok: true, archived: true, dataset: {id: 'ds-1'}})
        .install();

      const result = await runCommand([
        'datasets',
        'archive',
        'ds-1',
        '--yes',
        '--json',
        '--token',
        'exf_pat_test',
      ]);

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ok: true, archived: true, id: 'ds-1'});
    });
  });

  describe('datasets cleanup', () => {
    it('dry-runs lifecycle cleanup by default', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/lifecycle/cleanup')
        .body((body) => {
          const input = body as any;
          return input.dryRun === true
            && input.tag === 'benchmark'
            && input.olderThan === '7d'
            && input.limit === 25;
        })
        .reply(200, {
          ok: true,
          dryRun: true,
          filters: {tag: 'benchmark', olderThanMs: 604800000, now: '2026-05-19T00:00:00.000Z', limit: 25},
          summary: {candidates: 1, deleted: 0},
          candidates: [{id: 'ds-1', title: 'Scratch', rowCount: 0, createdAt: '2026-05-01T00:00:00.000Z', reasons: ['older_than']}],
          deletedIds: [],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'cleanup',
        '--tag',
        'benchmark',
        '--older-than',
        '7d',
        '--limit',
        '25',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.summary.candidates).toBe(1);
    });

    it('requires confirmation before applying cleanup', async () => {
      const denied = await runCommand([
        'datasets',
        'cleanup',
        '--tag',
        'benchmark',
        '--no-dry-run',
        '--no-input',
        '--token',
        'exf_pat_test',
      ]);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.error?.message).toContain('Use --yes');

      mockFetch()
        .on('POST', '/api/v1/datasets/lifecycle/cleanup')
        .body((body) => (body as any).dryRun === false && (body as any).tag === 'benchmark')
        .reply(202, {
          ok: true,
          dryRun: false,
          filters: {tag: 'benchmark', now: '2026-05-19T00:00:00.000Z', limit: 100},
          summary: {candidates: 1, deleted: 1},
          candidates: [{id: 'ds-1', title: 'Scratch', reasons: ['expired']}],
          deletedIds: ['ds-1'],
        })
        .install();

      const applied = await runCommand([
        'datasets',
        'cleanup',
        '--tag',
        'benchmark',
        '--no-dry-run',
        '--yes',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(applied.stdout);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.summary.deleted).toBe(1);
    });
  });

  describe('datasets validate', () => {
    it('returns stable JSON for template validation', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/validate')
        .body((body) => (body as any).template === 'sources')
        .reply(200, {
          ok: true,
          valid: true,
          template: 'sources',
          errors: [],
          warnings: [],
        })
        .install();

      const result = await runCommand(['datasets', 'validate', 'ds-1', '--template', 'sources', '--json', '--token', 'exf_pat_test']);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.template).toBe('sources');
    });
  });

  describe('datasets import', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sift-datasets-'));
    });

    afterEach(() => {
      rmSync(dir, {recursive: true, force: true});
    });

    it('dry-runs an existing dataset import without mutation', async () => {
      const file = join(dir, 'sources.jsonl');
      writeFileSync(file, '{"source_id":"s1","title":"Source 1"}\n');

      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/import')
        .body((body) => {
          const input = body as any;
          return input.dryRun === true
            && input.template === 'sources'
            && input.upsertBy === 'source_id'
            && input.rows[0].fields.source_id === 's1';
        })
        .reply(200, {
          ok: true,
          dryRun: true,
          datasetId: 'ds-1',
          template: 'sources',
          upsertBy: 'source_id',
          summary: {create: 1, update: 0, skip: 0, invalid: 0, warning: 0},
          errors: [],
          warnings: [],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'import',
        file,
        '--dataset-id',
        'ds-1',
        '--template',
        'sources',
        '--upsert-by',
        'source_id',
        '--dry-run',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.summary.create).toBe(1);
    });

    it('requires confirmation for mutating imports in non-interactive mode', async () => {
      const file = join(dir, 'sources.jsonl');
      writeFileSync(file, '{"source_id":"s1","title":"Source 1"}\n');

      const result = await runCommand([
        'datasets',
        'import',
        file,
        '--dataset-id',
        'ds-1',
        '--template',
        'sources',
        '--no-input',
        '--token',
        'exf_pat_test',
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('Use --yes');
    });
  });

  describe('datasets diff/apply-diff', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sift-datasets-diff-'));
    });

    afterEach(() => {
      rmSync(dir, {recursive: true, force: true});
    });

    it('creates a dry-run diff and saves an applyable plan', async () => {
      const file = join(dir, 'proposed.jsonl');
      const plan = join(dir, 'plan.json');
      writeFileSync(file, '{"source_id":"s1","title":"Source 1"}\n');

      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/import')
        .body((body) => {
          const input = body as any;
          return input.dryRun === true
            && input.template === 'sources'
            && input.upsertBy === 'source_id'
            && input.rows[0].fields.source_id === 's1';
        })
        .reply(200, {
          ok: true,
          dryRun: true,
          datasetId: 'ds-1',
          template: 'sources',
          upsertBy: 'source_id',
          summary: {create: 1, update: 0, skip: 0, invalid: 0, warning: 0},
          errors: [],
          warnings: [],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'diff',
        'ds-1',
        '--from-file',
        file,
        '--template',
        'sources',
        '--upsert-by',
        'source_id',
        '--save-plan',
        plan,
        '--json',
        '--token',
        'exf_pat_test',
      ]);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.planPath).toBe(plan);

      const saved = JSON.parse(require('node:fs').readFileSync(plan, 'utf8'));
      expect(saved.kind).toBe('sift.datasetDiffPlan');
      expect(saved.rows[0].fields.source_id).toBe('s1');
    });

    it('applies a saved diff plan only with confirmation in non-interactive mode', async () => {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify({
        kind: 'sift.datasetDiffPlan',
        version: 1,
        datasetId: 'ds-1',
        template: 'sources',
        upsertBy: 'source_id',
        batchSize: 100,
        rows: [{fields: {source_id: 's1', title: 'Source 1'}}],
      }));

      const denied = await runCommand([
        'datasets',
        'apply-diff',
        plan,
        '--no-input',
        '--token',
        'exf_pat_test',
      ]);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.error?.message).toContain('Use --yes');

      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/import')
        .body((body) => {
          const input = body as any;
          return input.dryRun === false
            && input.upsertBy === 'source_id'
            && input.rows[0].fields.source_id === 's1';
        })
        .reply(200, {
          ok: true,
          dryRun: false,
          datasetId: 'ds-1',
          template: 'sources',
          upsertBy: 'source_id',
          summary: {create: 0, update: 1, skip: 0, invalid: 0, warning: 0},
          errors: [],
          warnings: [],
          operationId: 'op-import-1',
        })
        .install();

      const applied = await runCommand([
        'datasets',
        'apply-diff',
        plan,
        '--yes',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(applied.stdout);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.summary.update).toBe(1);
      expect(parsed.operationId).toBe('op-import-1');
    });
  });

  describe('spreadsheet-style dataset commands', () => {
    it('looks up records by exact key', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/query')
        .body((body) => {
          const input = body as any;
          return input.filters[0].field === 'source_id'
            && input.filters[0].operator === '='
            && input.filters[0].value === 's1'
            && input.limit === 5;
        })
        .reply(200, {
          records: [{id: 'row-1', fields: {source_id: 's1', title: 'Source 1'}}],
          totalCount: 1,
        })
        .install();

      const result = await runCommand([
        'datasets',
        'lookup',
        'ds-1',
        '--key',
        'source_id',
        '--value',
        's1',
        '--limit',
        '5',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.records[0].id).toBe('row-1');
    });

    it('searches selected fields and merges records', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/query')
        .body((body) => {
          const input = body as any;
          return input.filters.some((filter: any) => filter.field === 'title' && filter.operator === 'contains');
        })
        .reply(200, {
          records: [{id: 'row-1', fields: {title: 'Shanghai source'}}],
        })
        .on('POST', '/api/v1/datasets/ds-1/query')
        .body((body) => {
          const input = body as any;
          return input.filters.some((filter: any) => filter.field === 'notes' && filter.operator === 'contains');
        })
        .reply(200, {
          records: [{id: 'row-2', fields: {notes: 'Shanghai mission'}}],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'search',
        'ds-1',
        'Shanghai',
        '--fields',
        'title,notes',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.records.map((record: any) => record.id)).toEqual(['row-1', 'row-2']);
      expect(parsed.matches).toEqual([{field: 'title', count: 1}, {field: 'notes', count: 1}]);
    });

    it('builds a pivot from aggregate rows', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/aggregate')
        .body((body) => {
          const input = body as any;
          return input.groupBy[0] === 'year'
            && input.groupBy[1] === 'source_type'
            && input.metrics[0].operation === 'count';
        })
        .reply(200, {
          rows: [
            {group: {year: '1900', source_type: 'letter'}, metrics: {count: 2}},
            {group: {year: '1900', source_type: 'book'}, metrics: {count: 1}},
          ],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'pivot',
        'ds-1',
        '--rows',
        'year',
        '--cols',
        'source_type',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.columns).toEqual(['book', 'letter']);
      expect(parsed.rows[0]).toMatchObject({year: '1900', letter: 2, book: 1});
    });

    it('finds duplicate key groups without mutating data', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/query')
        .body((body) => {
          const input = body as any;
          return input.sorts[0].field === 'normalized_name' && input.limit === 500;
        })
        .reply(200, {
          records: [
            {id: 'row-1', fields: {normalized_name: 'hudson taylor'}},
            {id: 'row-2', fields: {normalized_name: 'hudson taylor'}},
            {id: 'row-3', fields: {normalized_name: 'other'}},
          ],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'dedupe',
        'ds-1',
        '--key',
        'normalized_name',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.duplicateGroupCount).toBe(1);
      expect(parsed.duplicateGroups[0].recordIds).toEqual(['row-1', 'row-2']);
    });

    it('reconciles two datasets by key without mutating data', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/left-ds/query')
        .body((body) => {
          const input = body as any;
          return input.sorts[0].field === 'source_id';
        })
        .reply(200, {
          records: [
            {id: 'left-1', fields: {source_id: 's1'}},
            {id: 'left-2', fields: {source_id: 's2'}},
            {id: 'left-3', fields: {source_id: 's2'}},
          ],
        })
        .on('POST', '/api/v1/datasets/right-ds/query')
        .body((body) => {
          const input = body as any;
          return input.sorts[0].field === 'source_id';
        })
        .reply(200, {
          records: [
            {id: 'right-1', fields: {source_id: 's1'}},
            {id: 'right-2', fields: {source_id: 's3'}},
          ],
        })
        .install();

      const result = await runCommand([
        'datasets',
        'reconcile',
        'left-ds',
        'right-ds',
        '--left-key',
        'source_id',
        '--json',
        '--token',
        'exf_pat_test',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.summary).toMatchObject({matched: 1, leftOnly: 1, rightOnly: 1, duplicateKeys: 1});
      expect(parsed.duplicateKeys[0]).toMatchObject({key: 's2', leftCount: 2, rightCount: 0});
    });

    it('plans formula-computed row updates through the import planner', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sift-formula-plan-'));
      const plan = join(dir, 'formula-plan.json');
      try {
        mockFetch()
          .on('POST', '/api/v1/datasets/ds-1/compute')
          .body((body) => {
            const input = body as any;
            return input.computedFields[0].as === 'score'
              && input.select.includes('source_id')
              && input.limit === 2;
          })
          .reply(200, {
            datasetId: 'ds-1',
            rows: [
              {source_id: 's1', score: 0.91},
              {source_id: 's2', score: 0.72},
            ],
            columns: [],
          })
          .on('POST', '/api/v1/datasets/ds-1/import')
          .body((body) => {
            const input = body as any;
            return input.dryRun === true
              && input.upsertBy === 'source_id'
              && input.rows[0].fields.source_id === 's1'
              && input.rows[0].fields.score === 0.91;
          })
          .reply(200, {
            ok: true,
            dryRun: true,
            datasetId: 'ds-1',
            upsertBy: 'source_id',
            summary: {create: 0, update: 2, skip: 0, invalid: 0, warning: 0},
            errors: [],
            warnings: [],
          })
          .install();

        const result = await runCommand([
          'datasets',
          'formula-plan',
          'ds-1',
          '--computed-fields',
          '[{"as":"score","expression":"confidence * reliability"}]',
          '--upsert-by',
          'source_id',
          '--limit',
          '2',
          '--save-plan',
          plan,
          '--json',
          '--token',
          'exf_pat_test',
        ]);

        const parsed = JSON.parse(result.stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.importPlan.summary.update).toBe(2);
        expect(parsed.proposedRows[0].fields).toEqual({source_id: 's1', score: 0.91});

        const saved = JSON.parse(require('node:fs').readFileSync(plan, 'utf8'));
        expect(saved.kind).toBe('sift.datasetDiffPlan');
        expect(saved.rows[1].fields).toEqual({source_id: 's2', score: 0.72});
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    it('exports query results as JSONL without mutating the dataset', async () => {
      mockFetch()
        .on('POST', '/api/v1/datasets/ds-1/query')
        .body((body) => (body as any).limit === 2)
        .reply(200, {
          records: [
            {id: 'row-1', fields: {source_id: 's1', title: 'Source One'}},
            {id: 'row-2', fields: {source_id: 's2', title: 'Source Two'}},
          ],
          cursor: null,
        })
        .install();

      const result = await runCommand([
        'datasets',
        'export',
        'ds-1',
        '--format',
        'jsonl',
        '--limit',
        '2',
        '--token',
        'exf_pat_test',
      ]);

      const lines = result.stdout.trim().split('\n');
      expect(JSON.parse(lines[0])).toMatchObject({__id: 'row-1', source_id: 's1'});
      expect(JSON.parse(lines[1])).toMatchObject({__id: 'row-2', title: 'Source Two'});
    });
  });
});
