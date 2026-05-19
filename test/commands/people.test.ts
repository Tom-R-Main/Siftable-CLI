import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('people commands', () => {
  describe('people list', () => {
    it('lists people in table format', async () => {
      mockFetch()
        .on('GET', '/api/v1/people')
        .reply(200, {people: [fixtures.person(), fixtures.person({id: 'person-002', name: 'Jane Doe'})]})
        .install();

      const result = await runCommand(['people', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test Person');
      expect(result.stdout).toContain('Jane Doe');
    });
  });

  describe('people search', () => {
    it('searches people', async () => {
      mockFetch()
        .on('GET', '/api/v1/people')
        .reply(200, {people: [fixtures.person()]})
        .install();

      const result = await runCommand(['people', 'search', 'test', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test Person');
    });
  });

  it('gets a person profile as JSON', async () => {
    mockFetch()
      .on('GET', '/api/v1/people/person-001')
      .reply(200, {...fixtures.person(), relationships: [{id: 'rel-1', relationshipType: 'colleague'}]})
      .install();

    const result = await runCommand(['people', 'get', 'person-001', '--json', '--token', 'exf_pat_test']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.name).toBe('Test Person');
    expect(parsed.relationships[0].relationshipType).toBe('colleague');
  });

  it('dry-runs a person relationship without hitting the API', async () => {
    mockFetch().install();

    const result = await runCommand([
      'people',
      'relate',
      'person-a',
      'person-b',
      '--type',
      'collaborator',
      '--dry-run',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.relationship.personBId).toBe('person-b');
  });

  it('creates a person relationship when confirmed', async () => {
    mockFetch()
      .on('POST', '/api/v1/people/person-a/relationships')
      .body((body) => (body as any).personBId === 'person-b' && (body as any).relationshipType === 'collaborator')
      .reply(201, {
        id: 'rel-1',
        personAId: 'person-a',
        personBId: 'person-b',
        relationshipType: 'collaborator',
      })
      .install();

    const result = await runCommand([
      'people',
      'relate',
      'person-a',
      'person-b',
      '--type',
      'collaborator',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.relationship.id).toBe('rel-1');
  });

  it('shows a person-centered graph', async () => {
    mockFetch()
      .on('GET', '/api/v1/people-graph/focus/person-001')
      .query((url) => url.searchParams.get('depth') === '2')
      .reply(200, {focusPersonId: 'person-001', nodes: [{id: 'person-001', name: 'Test Person'}], edges: []})
      .install();

    const result = await runCommand(['people', 'graph', 'person-001', '--depth', '2', '--json', '--token', 'exf_pat_test']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.focusPersonId).toBe('person-001');
  });

  it('lists timeline facts for a person', async () => {
    mockFetch()
      .on('GET', '/api/v1/timeline')
      .query((url) => url.searchParams.get('entity') === 'person:person-001' && url.searchParams.get('order') === 'asc')
      .reply(200, {items: [{id: 'fact-1', title: 'Arrived in Shanghai'}], cursor: null, meta: {}})
      .install();

    const result = await runCommand(['people', 'timeline', 'person-001', '--json', '--token', 'exf_pat_test']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].title).toBe('Arrived in Shanghai');
  });
});
