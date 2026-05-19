import {mockFetch, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('events commands', () => {
  it('creates an event with person and source participants', async () => {
    mockFetch()
      .on('POST', '/api/v1/timeline')
      .body((body) => {
        const input = body as any;
        return input.factType === 'event'
          && input.title === 'Boxer Uprising'
          && input.time.yearCE === 1900
          && input.entities.some((entity: any) => entity.entityType === 'person' && entity.role === 'subject')
          && input.entities.some((entity: any) => entity.entityType === 'note' && entity.role === 'source');
      })
      .reply(201, {
        item: {id: 'fact-1', title: 'Boxer Uprising', factType: 'event', timeLabel: '1900'},
      })
      .install();

    const result = await runCommand([
      'events',
      'create',
      '--title',
      'Boxer Uprising',
      '--year',
      '1900',
      '--person',
      '11111111-1111-4111-8111-111111111111',
      '--source',
      'note:22222222-2222-4222-8222-222222222222:source',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.item.id).toBe('fact-1');
  });

  it('lists events for a person by using timeline event filters', async () => {
    mockFetch()
      .on('GET', '/api/v1/timeline')
      .query((url) => url.searchParams.get('fact_types') === 'event'
        && url.searchParams.get('entity') === 'person:11111111-1111-4111-8111-111111111111')
      .reply(200, {
        items: [{id: 'fact-1', title: 'Boxer Uprising', factType: 'event', timeLabel: '1900'}],
      })
      .install();

    const result = await runCommand([
      'events',
      'list',
      '--person',
      '11111111-1111-4111-8111-111111111111',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].title).toBe('Boxer Uprising');
  });

  it('requires confirmation before attaching a person to an event', async () => {
    const denied = await runCommand([
      'events',
      'attach-person',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '--no-input',
      '--token',
      'exf_pat_test',
    ]);

    expect(denied.exitCode).not.toBe(0);
    expect(denied.error?.message).toContain('Use --yes');
  });

  it('attaches a person to an existing event through the timeline entities route', async () => {
    mockFetch()
      .on('PATCH', '/api/v1/timeline/33333333-3333-4333-8333-333333333333/entities')
      .body((body) => {
        const input = body as any;
        return input.entities[0].entityType === 'person'
          && input.entities[0].entityId === '11111111-1111-4111-8111-111111111111'
          && input.entities[0].role === 'missionary';
      })
      .reply(200, {
        item: {
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Boxer Uprising',
          entities: [
            {entityType: 'person', entityId: '11111111-1111-4111-8111-111111111111', role: 'missionary'},
          ],
        },
      })
      .install();

    const result = await runCommand([
      'events',
      'attach-person',
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '--role',
      'missionary',
      '--yes',
      '--json',
      '--token',
      'exf_pat_test',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.item.entities[0].role).toBe('missionary');
  });
});
