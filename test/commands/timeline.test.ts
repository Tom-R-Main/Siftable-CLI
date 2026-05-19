import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('timeline commands', () => {
  it('lists timeline facts with filters', async () => {
    mockFetch()
      .on('GET', '/api/v1/timeline')
      .query((url) => url.searchParams.get('entity') === 'person:11111111-1111-4111-8111-111111111111'
        && url.searchParams.get('fact_types') === 'event'
        && url.searchParams.get('limit') === '10')
      .reply(200, {
        items: [{id: 'fact-1', title: 'Arrived', factType: 'event', timeLabel: '1887', confidence: 'high'}],
        cursor: null,
      })
      .install();

    const result = await runCommand([
      'timeline',
      'list',
      '--entity',
      'person:11111111-1111-4111-8111-111111111111',
      '--fact-types',
      'event',
      '--limit',
      '10',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].title).toBe('Arrived');
  });

  it('creates a timeline fact with an entity participant', async () => {
    mockFetch()
      .on('POST', '/api/v1/timeline')
      .body((body) => {
        const input = body as any;
        return input.title === 'Arrived in Shanghai'
          && input.time.yearCE === 1887
          && input.entities[0].entityType === 'person'
          && input.entities[0].role === 'subject'
          && input.provenance.label === 'Archive';
      })
      .reply(201, {
        item: {id: 'fact-1', title: 'Arrived in Shanghai', factType: 'event', timeLabel: '1887'},
      })
      .install();

    const result = await runCommand([
      'timeline',
      'create',
      '--title',
      'Arrived in Shanghai',
      '--year',
      '1887',
      '--entity',
      'person:11111111-1111-4111-8111-111111111111:subject',
      '--confidence',
      'high',
      '--source-label',
      'Archive',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.item.id).toBe('fact-1');
  });

  it('requires confirmation before deleting a timeline fact', async () => {
    const denied = await runCommand([
      'timeline',
      'delete',
      '11111111-1111-4111-8111-111111111111',
      '--no-input',
      '--token',
      'exf_pat_test',
    ]);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.error?.message).toContain('Use --yes');

    mockFetch()
      .on('DELETE', '/api/v1/timeline/11111111-1111-4111-8111-111111111111')
      .reply(204, {})
      .install();

    const applied = await runCommand([
      'timeline',
      'delete',
      '11111111-1111-4111-8111-111111111111',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(applied.stdout);
    expect(parsed.deleted).toBe(true);
  });

  it('requests a timeline narrative', async () => {
    mockFetch()
      .on('POST', '/api/v1/timeline/narrative')
      .body((body) => {
        const input = body as any;
        return input.action === 'summarize'
          && input.entity === 'person:11111111-1111-4111-8111-111111111111'
          && input.limit === 25;
      })
      .reply(200, {
        action: 'summarize',
        answer: 'A concise timeline.',
        itemCount: 2,
        factIds: [],
        supportingFacts: [],
      })
      .install();

    const result = await runCommand([
      'timeline',
      'narrative',
      '--entity',
      'person:11111111-1111-4111-8111-111111111111',
      '--limit',
      '25',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.answer).toBe('A concise timeline.');
  });
});
