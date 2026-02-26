import {mockFetch, fixtures, runCommand, restoreFetch} from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('calendar commands', () => {
  describe('calendar list', () => {
    it('lists events', async () => {
      mockFetch()
        .on('GET', '/api/v1/calendar/events')
        .reply(200, {events: [fixtures.event()]})
        .install();

      const result = await runCommand(['calendar', 'list', '--token', 'exf_pat_test']);
      expect(result.stdout).toContain('Test event');
    });

    it('returns JSON', async () => {
      mockFetch()
        .on('GET', '/api/v1/calendar/events')
        .reply(200, {events: [fixtures.event()]})
        .install();

      const result = await runCommand(['calendar', 'list', '--token', 'exf_pat_test', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json[0].title).toBe('Test event');
    });
  });

  describe('calendar create', () => {
    it('creates an event', async () => {
      mockFetch()
        .on('POST', '/api/v1/calendar/events')
        .reply(201, {event: fixtures.event({id: 'event-new'})})
        .install();

      const result = await runCommand([
        'calendar', 'create',
        '--title', 'Meeting',
        '--start', '2026-03-01T09:00:00Z',
        '--end', '2026-03-01T10:00:00Z',
        '--token', 'exf_pat_test',
      ]);
      expect(result.stdout).toContain('Event created');
    });
  });

  describe('calendar delete', () => {
    it('deletes with --yes', async () => {
      mockFetch()
        .on('DELETE', '/api/v1/calendar/events/event-001')
        .reply(200, {deleted: true})
        .install();

      const result = await runCommand(['calendar', 'delete', 'event-001', '--token', 'exf_pat_test', '--yes']);
      expect(result.stdout).toContain('deleted');
    });
  });
});
