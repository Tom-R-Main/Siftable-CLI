import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ALIAS_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ALIAS_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const PARTICIPANT_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const BUILDER_PARTICIPANT_ID = '77777777-7777-4777-8777-777777777777';
const BUILDER_ALIAS_ID = '88888888-8888-4888-8888-888888888888';
const RETIRED_PARTICIPANT_ID = '99999999-9999-4999-8999-999999999999';
const TWIN_PARTICIPANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TWIN_PARTICIPANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

installIsolatedConfigDirHooks('sift-cli-work-collaboration-');

afterEach(() => {
  restoreFetch();
  delete process.env.SIFT_AGENT_ALIAS_ID;
});

function participant() {
  return {
    version: 1,
    id: PARTICIPANT_ID,
    workItemId: WORK_ID,
    actor: {kind: 'agent', id: TARGET_ALIAS_ID, label: 'reviewer-agent'},
    role: 'reviewer',
    active: true,
    joinedAt: '2026-08-31T00:00:00.000Z',
    addedBy: {kind: 'agent', id: ACTOR_ALIAS_ID, label: 'coordinator-agent'},
    removedAt: null,
    removedBy: null,
  };
}

function roster() {
  const agent = (id: string, aliasId: string, label: string, role: string, active = true) => ({
    ...participant(),
    id,
    actor: {kind: 'agent', id: aliasId, label},
    role,
    active,
    removedAt: active ? null : '2026-08-31T00:05:00.000Z',
  });
  return {
    version: 1,
    participants: [
      participant(),
      agent(BUILDER_PARTICIPANT_ID, BUILDER_ALIAS_ID, 'builder-agent', 'contributor'),
      agent(RETIRED_PARTICIPANT_ID, '99999999-0000-4000-8000-000000000001', 'retired-agent', 'reviewer', false),
      agent(TWIN_PARTICIPANT_ID, 'aaaaaaaa-0000-4000-8000-000000000001', 'twin-agent', 'contributor'),
      agent(OTHER_TWIN_PARTICIPANT_ID, 'bbbbbbbb-0000-4000-8000-000000000001', 'Twin-Agent', 'observer'),
    ],
  };
}

function postedBodies(): unknown[] {
  return (global.fetch as jest.Mock).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body as string));
}

function event(text = 'Mailbox update') {
  return {
    version: 1,
    id: EVENT_ID,
    workItemId: WORK_ID,
    sequence: 7,
    actor: {kind: 'agent', id: ACTOR_ALIAS_ID, label: 'coordinator-agent'},
    createdAt: '2026-08-31T00:00:00.000Z',
    replyToEventId: null,
    supersedesEventId: null,
    kind: 'message',
    parts: [{kind: 'text', text}],
    details: null,
  };
}

describe('sift work collaboration', () => {
  it('publishes all seven collaboration command IDs in the generated manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'oclif.manifest.json'), 'utf8'),
    ) as {commands?: Record<string, unknown>};
    expect(Object.keys(manifest.commands ?? {})).toEqual(expect.arrayContaining([
      'work:collaboration:participants',
      'work:collaboration:participant:add',
      'work:collaboration:participant:remove',
      'work:collaboration:events',
      'work:collaboration:wait',
      'work:collaboration:send',
      'work:collaboration:acknowledge',
    ]));
  });

  it('lists participants under the selected agent actor and preserves the JSON envelope', async () => {
    const payload = {version: 1, participants: [participant()]};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/participants`)
      .reply(200, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'participants', WORK_ID,
      '--as-agent-id', ACTOR_ALIAS_ID,
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.headers['X-Sift-Agent-Alias-Id']).toBe(ACTOR_ALIAS_ID);
  });

  it('adds a participant with a caller-stable retry key outside the request body', async () => {
    const payload = {version: 1, participant: participant()};
    mockFetch()
      .on('POST', `/api/v1/work-items/${WORK_ID}/participants`)
      .body((body) => {
        expect(body).toEqual({
          participantUserId: USER_ID,
          agentAliasId: TARGET_ALIAS_ID,
          role: 'reviewer',
        });
        return true;
      })
      .reply(201, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'participant', 'add', WORK_ID,
      '--participant-user-id', USER_ID,
      '--agent-alias-id', TARGET_ALIAS_ID,
      '--role', 'reviewer',
      '--idempotency-key', 'participant-add-0001',
      '--as-agent-id', ACTOR_ALIAS_ID,
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.headers['Idempotency-Key']).toBe('participant-add-0001');
  });

  it('removes the exact participant using a required stable retry key', async () => {
    const removed = {...participant(), active: false, removedAt: '2026-08-31T00:01:00.000Z'};
    mockFetch()
      .on('DELETE', `/api/v1/work-items/${WORK_ID}/participants/${PARTICIPANT_ID}`)
      .reply(200, {version: 1, participant: removed})
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'participant', 'remove', WORK_ID, PARTICIPANT_ID,
      '--idempotency-key', 'participant-remove-0001',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.headers['Idempotency-Key']).toBe('participant-remove-0001');
  });

  it('lists ordered events after the caller-supplied sequence without acknowledging', async () => {
    const payload = {version: 1, events: [event()], nextSequence: 7};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events`)
      .query({afterSequence: '4', limit: '10'})
      .reply(200, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'events', WORK_ID,
      '--after-sequence', '4',
      '--limit', '10',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('waits from a stable consumer cursor and never auto-acknowledges delivered events', async () => {
    const payload = {
      version: 1,
      events: [event()],
      nextSequence: 7,
      consumerKey: 'cli-worker-main',
      timedOut: false,
    };
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events/wait`)
      .query({consumerKey: 'cli-worker-main', limit: '10', waitMs: '0'})
      .reply(200, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'wait', WORK_ID,
      '--consumer-key', 'cli-worker-main',
      '--limit', '10',
      '--wait-ms', '0',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe('GET');
  });

  it('acknowledges only the highest rendered event rather than the server page watermark', async () => {
    const payload = {
      version: 1,
      events: [event(), {...event(), sequence: 9}],
      nextSequence: 99,
      consumerKey: 'cli-worker-bounded',
      timedOut: false,
    };
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events/wait`)
      .query({consumerKey: 'cli-worker-bounded', waitMs: '0'})
      .reply(200, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'wait', WORK_ID,
      '--consumer-key', 'cli-worker-bounded',
      '--wait-ms', '0',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Server page watermark: 99');
    expect(result.stdout).toContain('--last-sequence 9');
    expect(result.stdout).not.toContain('--last-sequence 99');
  });

  it('does not offer acknowledgement after a wait times out without events', async () => {
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events/wait`)
      .query({consumerKey: 'cli-worker-timeout', waitMs: '0'})
      .reply(200, {
        version: 1,
        events: [],
        nextSequence: null,
        consumerKey: 'cli-worker-timeout',
        timedOut: true,
      })
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'wait', WORK_ID,
      '--consumer-key', 'cli-worker-timeout',
      '--wait-ms', '0',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Wait timed out with no events.');
    expect(result.stdout).toContain('cursor unchanged and no acknowledgement is needed');
    expect(result.stdout).not.toContain('work collaboration acknowledge');
    expect(result.stdout).not.toContain('--last-sequence');
  });

  it('redacts secret-shaped human previews while retaining the exact JSON event', async () => {
    const secrets = [
      ['sk', 'live', 'examplepassword'].join('-'),
      'hunter-example-password',
      'bearer-example-password',
      'query-example-password',
      ['github', 'pat', '1234567890abcdefghijklmnop'].join('_'),
      ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-'),
    ];
    const secretText = [
      `api_key=${secrets[0]}`,
      `password="${secrets[1]}"`,
      `Authorization: Bearer ${secrets[2]}`,
      `https://example.test/result?token=${secrets[3]}`,
      secrets[4],
      secrets[5],
      'ordinary output remains visible',
    ].join('\n');
    const payload = {version: 1, events: [event(secretText)], nextSequence: 7};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events`)
      .reply(200, payload)
      .install();

    const human = await runCommand([
      'work', 'collaboration', 'events', WORK_ID,
      '--token', 'sift_pat_test',
    ]);
    expect(human.exitCode).toBe(0);
    for (const secret of secrets) expect(human.stdout).not.toContain(secret);
    expect(human.stdout).toContain('[REDACTED]');
    expect(human.stdout).toContain('ordinary output remains visible');

    const json = await runCommand([
      'work', 'collaboration', 'events', WORK_ID,
      '--token', 'sift_pat_test',
      '--json',
    ]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(payload);
    for (const secret of secrets) expect(json.stdout).toContain(secret);
  });

  it('sends a text event with bounded human output and no terminal control leakage', async () => {
    const longText = `start\n\u001B[31m${'x'.repeat(600)}TAIL-MUST-NOT-APPEAR`;
    mockFetch()
      .on('POST', `/api/v1/work-items/${WORK_ID}/events`)
      .body((body) => {
        expect(body).toEqual({
          kind: 'message',
          parts: [{kind: 'text', text: longText}],
        });
        return true;
      })
      .reply(201, {version: 1, event: event(longText)})
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', longText,
      '--idempotency-key', 'event-send-0001',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Sent event: #7 message start');
    expect(result.stdout).not.toContain('\u001B[31m');
    expect(result.stdout).not.toContain('TAIL-MUST-NOT-APPEAR');
    expect(result.stdout).not.toContain('to:');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.headers['Idempotency-Key']).toBe('event-send-0001');
    expect(JSON.parse(request.body as string)).not.toHaveProperty('recipientParticipantIds');
  });

  it('resolves --to by label, alias, and participant ID into a sorted, retry-stable recipient list', async () => {
    const addressed = {...event('Please review'), recipientParticipantIds: [PARTICIPANT_ID, BUILDER_PARTICIPANT_ID]};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/participants`)
      .reply(200, roster())
      .on('POST', `/api/v1/work-items/${WORK_ID}/events`)
      .reply(201, {version: 1, event: addressed})
      .install();

    const first = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', 'Please review',
      '--to', 'REVIEWER-AGENT',
      '--to', BUILDER_ALIAS_ID,
      '--to', PARTICIPANT_ID.toUpperCase(),
      '--idempotency-key', 'event-send-addressed-0001',
      '--as-agent-id', ACTOR_ALIAS_ID,
      '--token', 'sift_pat_test',
    ]);
    const retry = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', 'Please review',
      '--to', BUILDER_PARTICIPANT_ID,
      '--to', 'reviewer-agent',
      '--idempotency-key', 'event-send-addressed-0001',
      '--as-agent-id', ACTOR_ALIAS_ID,
      '--token', 'sift_pat_test',
    ]);

    expect(first.exitCode).toBe(0);
    expect(retry.exitCode).toBe(0);
    const expectedBody = {
      kind: 'message',
      parts: [{kind: 'text', text: 'Please review'}],
      recipientParticipantIds: [PARTICIPANT_ID, BUILDER_PARTICIPANT_ID],
    };
    expect(postedBodies()).toEqual([expectedBody, expectedBody]);
    expect(first.stdout).toContain('Sent event: #7 message Please review');
    expect(first.stdout).toContain('to: reviewer-agent, builder-agent');
    const participantLookup = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(participantLookup.method).toBe('GET');
    expect(participantLookup.headers['X-Sift-Agent-Alias-Id']).toBe(ACTOR_ALIAS_ID);
  });

  it('returns the addressed event unchanged as JSON', async () => {
    const addressed = {...event(), recipientParticipantIds: [BUILDER_PARTICIPANT_ID]};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/participants`)
      .reply(200, roster())
      .on('POST', `/api/v1/work-items/${WORK_ID}/events`)
      .reply(201, {version: 1, event: addressed})
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', 'Mailbox update',
      '--to', 'builder-agent',
      '--idempotency-key', 'event-send-addressed-json',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({version: 1, event: addressed});
  });

  it.each([
    {
      name: 'an ambiguous label',
      ref: 'twin-agent',
      expected: [
        '--to "twin-agent" matches 2 active participants',
        `${TWIN_PARTICIPANT_ID} (twin-agent, contributor)`,
        `${OTHER_TWIN_PARTICIPANT_ID} (Twin-Agent, observer)`,
        'Use a participant ID.',
      ],
    },
    {
      name: 'a reference with no match',
      ref: 'nobody-agent',
      expected: [
        '--to "nobody-agent" matches no participant',
        `${PARTICIPANT_ID} (reviewer-agent, reviewer)`,
        `${BUILDER_PARTICIPANT_ID} (builder-agent, contributor)`,
      ],
    },
    {
      name: 'an inactive participant',
      ref: RETIRED_PARTICIPANT_ID,
      expected: [
        `matches only inactive participants: ${RETIRED_PARTICIPANT_ID} (retired-agent, reviewer)`,
        `Active participants: ${PARTICIPANT_ID} (reviewer-agent, reviewer)`,
      ],
    },
  ])('refuses to send when --to names $name', async ({ref, expected}) => {
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/participants`)
      .reply(200, roster())
      .on('POST', `/api/v1/work-items/${WORK_ID}/events`)
      .reply(201, {version: 1, event: event()})
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', 'hello',
      '--to', 'builder-agent',
      '--to', ref,
      '--idempotency-key', 'event-send-refused-0001',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).not.toBe(0);
    for (const fragment of expected) expect(result.error?.message).toContain(fragment);
    expect(postedBodies()).toEqual([]);
  });

  it('acknowledges only the exact supplied sequence and supports the actor environment variable', async () => {
    process.env.SIFT_AGENT_ALIAS_ID = ACTOR_ALIAS_ID;
    const payload = {
      version: 1,
      cursor: {
        version: 1,
        workItemId: WORK_ID,
        participantId: PARTICIPANT_ID,
        consumerKey: 'cli-worker-main',
        lastSequence: 7,
        acknowledgedAt: '2026-08-31T00:02:00.000Z',
      },
    };
    mockFetch()
      .on('POST', `/api/v1/work-items/${WORK_ID}/cursor`)
      .body((body) => {
        expect(body).toEqual({consumerKey: 'cli-worker-main', lastSequence: 7});
        return true;
      })
      .reply(200, payload)
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'acknowledge', WORK_ID,
      '--consumer-key', 'cli-worker-main',
      '--last-sequence', '7',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    const request = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(request.headers['X-Sift-Agent-Alias-Id']).toBe(ACTOR_ALIAS_ID);
  });

  it('lists events for the whole room unless --for-me selects the caller audience', async () => {
    const roomWide = event('Room update');
    const addressed = {...event('For the reviewer'), sequence: 8, recipientParticipantIds: [PARTICIPANT_ID]};
    const payload = {version: 1, events: [roomWide, addressed], nextSequence: 8};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events`)
      .reply(200, payload)
      .install();

    const all = await runCommand([
      'work', 'collaboration', 'events', WORK_ID,
      '--token', 'sift_pat_test',
    ]);
    const forMe = await runCommand([
      'work', 'collaboration', 'events', WORK_ID,
      '--for-me',
      '--as-agent-id', TARGET_ALIAS_ID,
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(all.exitCode).toBe(0);
    expect(forMe.exitCode).toBe(0);
    const urls = (global.fetch as jest.Mock).mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.searchParams.get('audience'))).toEqual([null, 'me']);
    expect(JSON.parse(forMe.stdout)).toEqual(payload);
    const lines = all.stdout.split('\n');
    expect(lines[0]).toBe('#7  message  coordinator-agent  Room update');
    expect(lines[1]).toBe(`#8  message  coordinator-agent  to: ${PARTICIPANT_ID}  For the reviewer`);
  });

  it('waits with --for-me and offers to acknowledge the examined watermark', async () => {
    const addressed = {...event('For the reviewer'), recipientParticipantIds: [PARTICIPANT_ID]};
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events/wait`)
      .query({consumerKey: 'cli-worker-for-me', audience: 'me', waitMs: '0'})
      .reply(200, {
        version: 1,
        events: [addressed],
        nextSequence: 12,
        consumerKey: 'cli-worker-for-me',
        timedOut: false,
      })
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'wait', WORK_ID,
      '--consumer-key', 'cli-worker-for-me',
      '--for-me',
      '--wait-ms', '0',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`to: ${PARTICIPANT_ID}`);
    expect(result.stdout).toContain('--last-sequence 12');
    expect(result.stdout).toContain('also covers the events filtered out by --for-me');
  });

  it('offers to acknowledge a --for-me timeout that examined only filtered events', async () => {
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/events/wait`)
      .query({consumerKey: 'cli-worker-for-me', audience: 'me', waitMs: '0'})
      .reply(200, {
        version: 1,
        events: [],
        nextSequence: 15,
        consumerKey: 'cli-worker-for-me',
        timedOut: true,
      })
      .install();

    const result = await runCommand([
      'work', 'collaboration', 'wait', WORK_ID,
      '--consumer-key', 'cli-worker-for-me',
      '--for-me',
      '--wait-ms', '0',
      '--token', 'sift_pat_test',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Wait timed out with no events.');
    expect(result.stdout).toContain(
      `sift work collaboration acknowledge ${WORK_ID} --consumer-key cli-worker-for-me --last-sequence 15`,
    );
  });

  it('refuses participant and event mutations without caller-owned retry keys', async () => {
    mockFetch().install();
    const add = await runCommand([
      'work', 'collaboration', 'participant', 'add', WORK_ID,
      '--participant-user-id', USER_ID,
      '--role', 'observer',
      '--token', 'sift_pat_test',
      '--json',
    ]);
    const send = await runCommand([
      'work', 'collaboration', 'send', WORK_ID,
      '--text', 'hello',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(add.exitCode).toBe(2);
    expect(send.exitCode).toBe(2);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
