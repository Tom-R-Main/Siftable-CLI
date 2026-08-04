import {BaseCommand} from '../../src/lib/base-command';
import RelationshipMeetingsBriefCreate from '../../src/commands/relationships/meetings/brief/create';
import RelationshipMeetingsBriefShow from '../../src/commands/relationships/meetings/brief/show';
import RelationshipMeetingsEvidenceCapture from '../../src/commands/relationships/meetings/evidence/capture';
import RelationshipMeetingsEvidenceShow from '../../src/commands/relationships/meetings/evidence/show';
import RelationshipMeetingsProposalsApply from '../../src/commands/relationships/meetings/proposals/apply';
import RelationshipMeetingsProposalsCreate from '../../src/commands/relationships/meetings/proposals/create';
import RelationshipMeetingsProposalsList from '../../src/commands/relationships/meetings/proposals/list';
import RelationshipMeetingsProposalsReview from '../../src/commands/relationships/meetings/proposals/review';
import RelationshipMeetingsProposalsShow from '../../src/commands/relationships/meetings/proposals/show';

const api = '/api/v1/relationship-meetings';
const ownerId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

function prepare<T extends BaseCommand>(instance: T, parsed: unknown, response: unknown): jest.Mock {
  (instance as any).parse = jest.fn().mockResolvedValue(parsed);
  const apiRequest = jest.fn().mockResolvedValue(response);
  (instance as any).apiRequest = apiRequest;
  (instance as any).jsonEnabled = () => true;
  return apiRequest;
}

describe('relationship meeting CLI adapters', () => {
  test.each([
    ['create', RelationshipMeetingsBriefCreate],
    ['show', RelationshipMeetingsBriefShow],
  ])('%s recomposes a read-only cited brief from exact JSON', async (_name, Command) => {
    const instance = command(Command);
    const input = {
      owner: {type: 'workspace', id: ownerId},
      subject: {kind: 'opportunity', id: eventId},
      generatedAssetId: proposalId,
      timeZone: 'America/Detroit',
    };
    const flags = {input: JSON.stringify(input)};
    const brief = {briefId: eventId, subject: input.subject, citations: [{sourceId: 'asset'}]};
    const apiRequest = prepare(instance, {flags}, {brief});

    await expect(instance.run()).resolves.toBe(brief);

    expect(apiRequest).toHaveBeenCalledWith(flags, `${api}/briefs`, {
      method: 'POST',
      body: input,
    });
    expect(Command.flags).not.toHaveProperty('idempotency-key');
    expect(Command.flags).not.toHaveProperty('yes');
  });

  test('evidence capture sends the caller key in both payload and transport', async () => {
    const instance = command(RelationshipMeetingsEvidenceCapture);
    const input = {
      owner: {type: 'workspace', id: ownerId},
      subject: {kind: 'opportunity', id: proposalId},
      occurredAt: '2026-08-04T12:00:00.000Z',
      authorization: {captureMode: 'manual_notes'},
      segments: [{segmentId: 'segment-1', text: 'Buyer named the next step.'}],
      idempotencyKey: 'meeting-evidence-0001',
    };
    const flags = {
      input: JSON.stringify(input),
      'idempotency-key': 'meeting-evidence-0001',
      yes: true,
    };
    const response = {evidence: {eventId, authorization: input.authorization, segments: input.segments}};
    const apiRequest = prepare(instance, {flags}, response);
    (instance as any).confirmAction = jest.fn().mockResolvedValue(true);

    await expect(instance.run()).resolves.toBe(response);

    expect(apiRequest).toHaveBeenCalledWith(flags, `${api}/evidence`, {
      method: 'POST',
      idempotencyKey: 'meeting-evidence-0001',
      body: input,
    });
  });

  test('evidence show scopes inspection to the exact owner', async () => {
    const instance = command(RelationshipMeetingsEvidenceShow);
    const flags = {workspace: ownerId};
    const evidence = {eventId, segments: []};
    const apiRequest = prepare(instance, {args: {id: eventId}, flags}, {evidence});

    await expect(instance.run()).resolves.toBe(evidence);

    expect(apiRequest).toHaveBeenCalledWith(
      flags,
      `${api}/evidence/${eventId}`,
    );
  });

  test('proposal creation preserves the registered action and immutable evidence references', async () => {
    const instance = command(RelationshipMeetingsProposalsCreate);
    const input = {
      owner: {type: 'workspace', id: ownerId},
      meetingEvidenceEventId: eventId,
      action: {
        actionId: 'relationship.next_action.set',
        entity: {kind: 'opportunity', id: proposalId},
        input: {title: 'Confirm legal review'},
      },
      evidenceSegmentIds: ['segment-1'],
      reason: 'Buyer committed to a legal review.',
    };
    const flags = {
      input: JSON.stringify(input),
      'idempotency-key': ['meeting', 'proposal', '0001'].join('-'),
      yes: true,
    };
    const proposal = {proposalId, action: input.action, status: 'pending'};
    const apiRequest = prepare(instance, {flags}, {proposal});
    (instance as any).confirmAction = jest.fn().mockResolvedValue(true);

    await expect(instance.run()).resolves.toBe(proposal);

    expect(apiRequest).toHaveBeenCalledWith(flags, `${api}/proposals`, {
      method: 'POST',
      idempotencyKey: ['meeting', 'proposal', '0001'].join('-'),
      body: {...input, idempotencyKey: ['meeting', 'proposal', '0001'].join('-')},
    });
  });

  test('proposal list and show expose the same owner-scoped lifecycle', async () => {
    const list = command(RelationshipMeetingsProposalsList);
    const show = command(RelationshipMeetingsProposalsShow);
    const listFlags = {
      workspace: ownerId,
      status: 'approved',
      'subject-kind': 'opportunity',
      'subject-id': eventId,
    };
    const showFlags = {workspace: ownerId};
    const proposal = {proposalId, status: 'approved'};
    const listRequest = prepare(list, {flags: listFlags}, {proposals: [proposal]});
    const showRequest = prepare(show, {args: {id: proposalId}, flags: showFlags}, {proposal});

    await expect(list.run()).resolves.toMatchObject({proposals: [proposal]});
    await expect(show.run()).resolves.toBe(proposal);

    expect(listRequest).toHaveBeenCalledWith(
      listFlags,
      `${api}/proposals?status=approved&subjectKind=opportunity&subjectId=${eventId}`,
    );
    expect(showRequest).toHaveBeenCalledWith(
      showFlags,
      `${api}/proposals/${proposalId}`,
    );
  });

  test('review and apply remain separate, explicit, digest-bound commands', async () => {
    const review = command(RelationshipMeetingsProposalsReview);
    const apply = command(RelationshipMeetingsProposalsApply);
    const reviewInput = {
      decision: 'approved',
      reason: 'Evidence and before/after state checked.',
      expectedProposalDigest: 'a'.repeat(64),
    };
    const reviewFlags = {
      workspace: ownerId,
      input: JSON.stringify(reviewInput),
      yes: true,
    };
    const applyFlags = {
      workspace: ownerId,
      'expected-proposal-digest': 'a'.repeat(64),
      yes: true,
    };
    const reviewed = {proposalId, status: 'approved'};
    const receipt = {proposalId, status: 'committed'};
    const reviewRequest = prepare(review, {args: {id: proposalId}, flags: reviewFlags}, {proposal: reviewed});
    const applyRequest = prepare(apply, {args: {id: proposalId}, flags: applyFlags}, {receipt});
    (review as any).confirmAction = jest.fn().mockResolvedValue(true);
    (apply as any).confirmAction = jest.fn().mockResolvedValue(true);

    await expect(review.run()).resolves.toBe(reviewed);
    await expect(apply.run()).resolves.toBe(receipt);

    expect(reviewRequest).toHaveBeenCalledWith(
      reviewFlags,
      `${api}/proposals/${proposalId}/reviews`,
      {method: 'POST', body: reviewInput},
    );
    expect(applyRequest).toHaveBeenCalledWith(
      applyFlags,
      `${api}/proposals/${proposalId}/apply`,
      {
        method: 'POST',
        body: {expectedProposalDigest: 'a'.repeat(64)},
      },
    );
    for (const Command of [
      RelationshipMeetingsEvidenceCapture,
      RelationshipMeetingsProposalsCreate,
    ]) {
      expect((Command.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
    }
    expect((RelationshipMeetingsProposalsApply.flags['expected-proposal-digest'] as {required?: boolean}).required).toBe(true);
  });

  test('persistent commands reject mismatched payload and transport idempotency', async () => {
    const instance = command(RelationshipMeetingsProposalsCreate);
    (instance as any).parse = jest.fn().mockResolvedValue({
      flags: {
        input: JSON.stringify({idempotencyKey: 'payload-key-0001'}),
        'idempotency-key': 'transport-key-0001',
        yes: true,
      },
    });
    (instance as any).error = jest.fn((message: string) => { throw new Error(message); });
    (instance as any).apiRequest = jest.fn();

    await expect(instance.run()).rejects.toThrow('must match --idempotency-key');
    expect((instance as any).apiRequest).not.toHaveBeenCalled();
  });
});
