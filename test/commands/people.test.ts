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
});
