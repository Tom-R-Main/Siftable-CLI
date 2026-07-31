import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

afterAll(() => restoreFetch());

const recommendationId = '11111111-1111-4111-8111-111111111111';
const subjectId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  recommendationId,
  subject: {kind: 'opportunity', id: subjectId},
  priorityScore: 82,
  executable: true,
  suppressionReasons: [],
  sourceDigest: 'a'.repeat(64),
  rankingVersion: 'relationship-ranking.v1',
  policyVersion: 'relationship-policy.v1',
  gates: [{code: 'citations_present', status: 'passed', reason: 'One exact citation is available.'}],
};
const record = {snapshot, state: 'pending_review', latestReview: null, executedAt: null};

describe('relationships CLI', () => {
  it('composes a structured brief and lists or shows immutable recommendations', async () => {
    mockFetch()
      .on('POST', '/api/v1/relationships/brief')
      .body((body) => (body as {subject?: {kind?: string}}).subject?.kind === 'opportunity')
      .reply(200, {brief: {subjectLabel: 'Acme renewal', citations: [{}], recommendations: [snapshot]}})
      .on('GET', '/api/v1/relationships/recommendations')
      .query((url) => url.searchParams.get('subjectType') === 'opportunity'
        && url.searchParams.get('subjectId') === subjectId)
      .reply(200, {recommendations: [record]})
      .on('GET', `/api/v1/relationships/recommendations/${recommendationId}`)
      .reply(200, {recommendation: record})
      .install();

    const brief = await runCommand(['relationships', 'brief', `opportunity:${subjectId}`, '--json', '--token', 'exf_pat_test']);
    const list = await runCommand(['relationships', 'recommendations', 'list', '--subject', `opportunity:${subjectId}`, '--json', '--token', 'exf_pat_test']);
    const show = await runCommand(['relationships', 'recommendations', 'show', recommendationId, '--json', '--token', 'exf_pat_test']);

    expect(JSON.parse(brief.stdout).subjectLabel).toBe('Acme renewal');
    expect(JSON.parse(list.stdout)[0].snapshot.recommendationId).toBe(recommendationId);
    expect(JSON.parse(show.stdout).snapshot.sourceDigest).toBe('a'.repeat(64));
  });

  it('completes review and execute without a GUI step', async () => {
    mockFetch()
      .on('POST', `/api/v1/relationships/recommendations/${recommendationId}/reviews`)
      .body((body) => (body as {decision?: string}).decision === 'accepted')
      .reply(201, {recommendation: {...record, state: 'accepted'}})
      .on('POST', `/api/v1/relationships/recommendations/${recommendationId}/execute`)
      .reply(200, {recommendation: {...record, state: 'executed'}, outcome: {status: 'applied'}})
      .install();

    const reviewed = await runCommand([
      'relationships', 'recommendations', 'review', recommendationId,
      '--decision', 'accepted', '--yes', '--json', '--token', 'exf_pat_test',
    ]);
    const executed = await runCommand([
      'relationships', 'recommendations', 'execute', recommendationId,
      '--yes', '--json', '--token', 'exf_pat_test',
    ]);

    expect(JSON.parse(reviewed.stdout).state).toBe('accepted');
    expect(JSON.parse(executed.stdout).outcome.status).toBe('applied');
  });

  it('lists and runs the canonical relationship action binding', async () => {
    mockFetch()
      .on('GET', '/api/v1/ontology/relationship-actions')
      .reply(200, {version: 1, actions: [{id: 'relationship.next_action.set', label: 'Set next action'}]})
      .on('POST', '/api/v1/ontology/relationship-actions/run')
      .body((body) => (body as {actionId?: string}).actionId === 'relationship.next_action.set')
      .reply(200, {result: {actionId: 'relationship.next_action.set', status: 'applied'}})
      .install();

    const listed = await runCommand(['relationships', 'actions', 'list', '--json', '--token', 'exf_pat_test']);
    const run = await runCommand([
      'relationships', 'actions', 'run', 'relationship.next_action.set',
      '--entity', `opportunity:${subjectId}`,
      '--input', JSON.stringify({title: 'Follow up', dueAt: '2026-08-03T17:00:00.000Z'}),
      '--yes', '--json', '--token', 'exf_pat_test',
    ]);

    expect(JSON.parse(listed.stdout).actions[0].id).toBe('relationship.next_action.set');
    expect(JSON.parse(run.stdout).status).toBe('applied');
  });
});
