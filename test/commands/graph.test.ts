import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('graph commands', () => {
  it('searches linkable entities', async () => {
    mockFetch()
      .on('GET', '/api/v1/entities/search')
      .query((url) => url.searchParams.get('q') === 'Hudson'
        && url.searchParams.get('types') === 'person,organization'
        && url.searchParams.get('limit') === '5')
      .reply(200, {
        results: [{entityType: 'person', entityId: 'person-1', label: 'Hudson Taylor'}],
      })
      .install();

    const result = await runCommand([
      'graph',
      'search',
      'Hudson',
      '--types',
      'person,organization',
      '--limit',
      '5',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results[0].label).toBe('Hudson Taylor');
  });

  it('previews an entity reference', async () => {
    mockFetch()
      .on('GET', '/api/v1/entities/person/11111111-1111-4111-8111-111111111111/preview')
      .reply(200, {
        preview: {entityType: 'person', entityId: '11111111-1111-4111-8111-111111111111', label: 'Hudson Taylor'},
      })
      .install();

    const result = await runCommand([
      'graph',
      'preview',
      'person:11111111-1111-4111-8111-111111111111',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.preview.label).toBe('Hudson Taylor');
  });

  it('shows graph neighbors', async () => {
    mockFetch()
      .on('GET', '/api/v1/entities/person/11111111-1111-4111-8111-111111111111/graph')
      .query((url) => url.searchParams.get('depth') === '2' && url.searchParams.get('limit') === '25')
      .reply(200, {
        graph: {
          nodes: [{entityType: 'person', entityId: '11111111-1111-4111-8111-111111111111', label: 'Hudson Taylor'}],
          edges: [],
        },
      })
      .install();

    const result = await runCommand([
      'graph',
      'neighbors',
      'person:11111111-1111-4111-8111-111111111111',
      '--depth',
      '2',
      '--limit',
      '25',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.graph.nodes[0].label).toBe('Hudson Taylor');
  });

  it('explains a bounded server-side path between two entities', async () => {
    mockFetch()
      .on('GET', '/api/v1/entities/person/11111111-1111-4111-8111-111111111111/path/organization/22222222-2222-4222-8222-222222222222')
      .query((url) => url.searchParams.get('maxDepth') === '4' && url.searchParams.get('frontierLimit') === '500')
      .reply(200, {
        path: {
          found: true,
          maxDepth: 4,
          pathLength: 2,
          truncated: false,
          path: [
            {
              edgeId: 'edge-1',
              from: {entityType: 'person', entityId: '11111111-1111-4111-8111-111111111111', label: 'Hudson Taylor'},
              to: {entityType: 'temporal_fact', entityId: '33333333-3333-4333-8333-333333333333', label: 'Arrived in Shanghai'},
              linkType: 'related',
              direction: 'forward',
              contextField: 'temporal_participation',
            },
            {
              edgeId: 'edge-2',
              from: {entityType: 'temporal_fact', entityId: '33333333-3333-4333-8333-333333333333', label: 'Arrived in Shanghai'},
              to: {entityType: 'organization', entityId: '22222222-2222-4222-8222-222222222222', label: 'China Inland Mission'},
              linkType: 'related',
              direction: 'forward',
              contextField: 'temporal_participation',
            },
          ],
        },
      })
      .install();

    const result = await runCommand([
      'graph',
      'explain',
      'person:11111111-1111-4111-8111-111111111111',
      'organization:22222222-2222-4222-8222-222222222222',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.found).toBe(true);
    expect(parsed.pathLength).toBe(2);
    expect(parsed.path[0].contextField).toBe('temporal_participation');
  });
});
