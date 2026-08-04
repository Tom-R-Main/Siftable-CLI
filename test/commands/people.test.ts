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

    it('passes owner context and relationship category filters', async () => {
      mockFetch()
        .on('GET', '/api/v1/people')
        .query((url) => url.searchParams.get('context') === 'work'
          && url.searchParams.get('relationshipCategory') === 'professional')
        .reply(200, {people: [fixtures.person({contexts: ['work']})]})
        .install();

      const result = await runCommand([
        'people', 'list', '--context', 'work', '--category', 'professional', '--json', '--token', 'exf_pat_test',
      ]);
      expect(JSON.parse(result.stdout)[0].contexts).toEqual(['work']);
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

  it('lists owner-relative context relationships separately from person graph edges', async () => {
    mockFetch()
      .on('GET', '/api/v1/people/person-001/context-relationships')
      .reply(200, {contexts: ['personal', 'work'], relationships: [
        {id: 'owner-rel-1', context: 'personal', relationshipType: 'friend', isPrimary: true},
        {id: 'owner-rel-2', context: 'work', relationshipType: 'client', isPrimary: true},
      ]})
      .install();

    const result = await runCommand(['people', 'context', 'list', 'person-001', '--json', '--token', 'exf_pat_test']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.contexts).toEqual(['personal', 'work']);
    expect(parsed.relationships).toHaveLength(2);
  });

  it('adds a Work relationship through the headless context API', async () => {
    mockFetch()
      .on('POST', '/api/v1/people/person-001/context-relationships')
      .body((body) => (body as any).context === 'work' && (body as any).relationshipType === 'client')
      .reply(201, {relationship: {id: 'owner-rel-2', context: 'work', relationshipType: 'client', isPrimary: true}})
      .install();

    const result = await runCommand([
      'people', 'context', 'add', 'person-001', '--context', 'work', '--relationship', 'client',
      '--json', '--token', 'exf_pat_test',
    ]);
    expect(JSON.parse(result.stdout).relationship.id).toBe('owner-rel-2');
  });

  it('server-validates a context removal dry run without mutating', async () => {
    mockFetch()
      .on('DELETE', '/api/v1/people/person-001/context-relationships/owner-rel-2')
      .query((url) => url.searchParams.get('dryRun') === 'true')
      .reply(200, {dryRun: true, wouldDelete: {id: 'owner-rel-2', context: 'work'}})
      .install();

    const result = await runCommand([
      'people', 'context', 'remove', 'person-001', 'owner-rel-2', '--dry-run',
      '--json', '--token', 'exf_pat_test',
    ]);
    expect(JSON.parse(result.stdout).wouldDelete.id).toBe('owner-rel-2');
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
