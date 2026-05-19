import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('research commands', () => {
  it('plans a deterministic research workflow', async () => {
    const result = await runCommand([
      'research',
      'plan',
      'Missionaries in China',
      '--source-dataset',
      'sources-ds',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan.steps.some((step: any) => step.command.includes('datasets import'))).toBe(true);
    expect(parsed.plan.verification.length).toBeGreaterThan(0);
  });

  it('dry-runs research init without API calls', async () => {
    const result = await runCommand([
      'research',
      'init',
      'Missionaries in China',
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.datasets.map((dataset: any) => dataset.template)).toEqual(['sources', 'people', 'events', 'claims']);
  });

  it('creates a research project and standard datasets after confirmation', async () => {
    mockFetch()
      .on('POST', '/api/v1/projects')
      .body((body) => (body as any).name === 'Missionaries in China')
      .reply(200, {
        project: {id: 'project-1', name: 'Missionaries in China'},
      })
      .on('POST', '/api/v1/datasets')
      .body((body) => (body as any).metadata?.datasetTemplate === 'sources')
      .reply(200, {dataset: {id: 'sources-ds', title: 'Missionaries in China sources'}})
      .on('POST', '/api/v1/datasets')
      .body((body) => (body as any).metadata?.datasetTemplate === 'people')
      .reply(200, {dataset: {id: 'people-ds', title: 'Missionaries in China people'}})
      .on('POST', '/api/v1/datasets')
      .body((body) => (body as any).metadata?.datasetTemplate === 'events')
      .reply(200, {dataset: {id: 'events-ds', title: 'Missionaries in China events'}})
      .on('POST', '/api/v1/datasets')
      .body((body) => (body as any).metadata?.datasetTemplate === 'claims')
      .reply(200, {dataset: {id: 'claims-ds', title: 'Missionaries in China claims'}})
      .install();

    const result = await runCommand([
      'research',
      'init',
      'Missionaries in China',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.project.id).toBe('project-1');
    expect(parsed.datasets).toHaveLength(4);
  });

  it('reports research status with project context', async () => {
    mockFetch()
      .on('GET', '/api/v1/projects/project-1/context')
      .reply(200, {
        project: {id: 'project-1', name: 'Missionaries in China'},
        notes: [],
        tasks: [],
      })
      .install();

    const result = await runCommand([
      'research',
      'status',
      'project-1',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.context.project.id).toBe('project-1');
    expect(parsed.readiness.some((capability: any) => capability.id === 'research.workflow')).toBe(true);
  });

  it('dry-runs research work creation', async () => {
    const result = await runCommand([
      'research',
      'run',
      'extract-people',
      '--source-dataset',
      'sources-ds',
      '--project',
      'project-1',
      '--dry-run',
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.workItem.inputContext.sourceDatasetId).toBe('sources-ds');
    expect(parsed.workItem.writeScope.mode).toBe('diff-first');
  });

  it('creates research work after confirmation', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items')
      .body((body) => {
        const input = body as any;
        return input.assignedAlias === 'researcher'
          && input.projectId === 'project-1'
          && input.inputContext.sourceDatasetId === 'sources-ds'
          && input.acceptanceCriteria.length > 0
          && input.verificationCommands.length > 0;
      })
      .reply(200, {
        workItem: {id: 'work-1', title: 'Extract research people from sources'},
      })
      .install();

    const result = await runCommand([
      'research',
      'run',
      'extract-people',
      '--source-dataset',
      'sources-ds',
      '--project',
      'project-1',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.workItem.id).toBe('work-1');
    expect(parsed.next[0]).toContain('sift work get work-1');
  });
});
