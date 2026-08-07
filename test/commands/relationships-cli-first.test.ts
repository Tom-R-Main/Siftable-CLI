import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import RelationshipActionsRun from '../../src/commands/relationships/actions/run.js';
import RelationshipActionsDryRun from '../../src/commands/relationships/actions/dry-run.js';
import RelationshipSequencesCreate from '../../src/commands/relationships/sequences/create.js';
import RelationshipSequencesUpdate from '../../src/commands/relationships/sequences/update.js';
import RelationshipSequencesEnroll from '../../src/commands/relationships/sequences/enroll.js';
import RelationshipSequencesPause from '../../src/commands/relationships/sequences/pause.js';
import RelationshipSequencesResume from '../../src/commands/relationships/sequences/resume.js';
import RelationshipSequencesDryRun from '../../src/commands/relationships/sequences/dry-run.js';
import RelationshipProposalsRequestApproval from '../../src/commands/relationships/proposals/request-approval.js';
import RelationshipEmailAccountsList from '../../src/commands/relationships/email-accounts/list.js';
import RelationshipPlaybooksCreate from '../../src/commands/relationships/playbooks/create.js';
import RelationshipPlaybooksReview from '../../src/commands/relationships/playbooks/review.js';
import RelationshipDiagnosesCreate from '../../src/commands/relationships/diagnoses/create.js';
import RelationshipPlaybookRecommendationsCreate from '../../src/commands/relationships/playbook-recommendations/create.js';
import RelationshipGeneratedAssetsGenerate from '../../src/commands/relationships/generated-assets/generate.js';
import RelationshipGeneratedAssetsReview from '../../src/commands/relationships/generated-assets/review.js';
import RelationshipGeneratedAssetsDraft from '../../src/commands/relationships/generated-assets/draft.js';
import RelationshipGeneratedAssetsReviewHistory from '../../src/commands/relationships/generated-assets/review-history.js';
import RelationshipGeneratedAssetsUsageList from '../../src/commands/relationships/generated-assets/usage-list.js';
import RelationshipGeneratedAssetsUsageRecord from '../../src/commands/relationships/generated-assets/usage-record.js';
import RelationshipSourceAssetsShow from '../../src/commands/relationships/source-assets/show.js';

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

const tempDir = mkdtempSync(join(tmpdir(), 'sift-relationship-playbooks-'));

afterAll(() => rmSync(tempDir, {recursive: true, force: true}));

function jsonFile(name: string, value: unknown): string {
  const path = join(tempDir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('relationship CLI-first adapters', () => {
  test('action run passes the exact stable idempotency key to the client', async () => {
    const instance = command(RelationshipActionsRun);
    const runRelationshipAction = jest.fn().mockResolvedValue({
      statusCode: 200,
      data: {
        execution: {id: 'execution-1', status: 'verified'},
        proposal: {id: 'proposal-1', status: 'pending'},
        outcome: {status: 'proposed'},
        replay: false,
      },
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'relationship.communication.send'},
      flags: {input: '{"personId":"person-1"}', 'idempotency-key': 'stable-action-001', yes: true},
    });
    (instance as any).client = jest.fn().mockResolvedValue({runRelationshipAction});
    (instance as any).handleApiError = jest.fn();
    (instance as any).unwrapOne = (response: any, key: string) => response.data[key];
    (instance as any).jsonEnabled = () => true;

    const result = await instance.run();

    expect(runRelationshipAction).toHaveBeenCalledWith(
      'relationship.communication.send',
      {input: {personId: 'person-1'}},
      'stable-action-001',
    );
    expect(result).toMatchObject({
      execution: {id: 'execution-1'},
      proposal: {id: 'proposal-1'},
      replay: false,
    });
    expect((RelationshipActionsRun.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
  });

  test('server-side dry-run has no approval or local execution escape hatch', async () => {
    const instance = command(RelationshipActionsDryRun);
    const dryRunRelationshipAction = jest.fn().mockResolvedValue({
      statusCode: 200,
      data: {dryRun: {commitmentClass: 'external_communication', wouldRequireApproval: true}},
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'relationship.communication.send'},
      flags: {input: '{}', 'idempotency-key': 'stable-preview-001'},
    });
    (instance as any).client = jest.fn().mockResolvedValue({dryRunRelationshipAction});
    (instance as any).handleApiError = jest.fn();
    (instance as any).unwrapOne = (response: any, key: string) => response.data[key];
    (instance as any).jsonEnabled = () => true;

    const result = await instance.run();

    expect(result).toMatchObject({wouldRequireApproval: true});
    expect(dryRunRelationshipAction).toHaveBeenCalledWith(
      'relationship.communication.send',
      {input: {}},
      'stable-preview-001',
    );
    expect(RelationshipActionsDryRun.flags).not.toHaveProperty('approval');
    expect(RelationshipActionsDryRun.flags).not.toHaveProperty('execute-locally');
  });

  test('email account discovery returns only explicit usable sender choices', async () => {
    const instance = command(RelationshipEmailAccountsList);
    const accounts = [
      {id: 'account-1', label: 'Work', emailAddress: 'work@example.com', provider: 'gmail', status: 'active', syncEnabled: true},
      {id: 'account-2', label: 'Paused', emailAddress: 'paused@example.com', provider: 'gmail', status: 'active', syncEnabled: false},
      {id: 'account-3', label: 'Broken', emailAddress: 'broken@example.com', provider: 'imap', status: 'error', syncEnabled: true},
    ];
    (instance as any).parse = jest.fn().mockResolvedValue({flags: {}});
    (instance as any).apiRequest = jest.fn().mockResolvedValue({accounts});
    (instance as any).jsonEnabled = () => true;

    await expect(instance.run()).resolves.toEqual([accounts[0]]);
    expect((instance as any).apiRequest).toHaveBeenCalledWith({}, '/api/v1/email/accounts');
  });

  test('every write and server-side preview requires a caller-owned idempotency key', async () => {
    const commands = [
      RelationshipActionsRun,
      RelationshipActionsDryRun,
      RelationshipSequencesCreate,
      RelationshipSequencesUpdate,
      RelationshipSequencesEnroll,
      RelationshipSequencesPause,
      RelationshipSequencesResume,
      RelationshipSequencesDryRun,
      RelationshipProposalsRequestApproval,
    ];
    for (const commandClass of commands) {
      expect((commandClass.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
    }
  });

  test('proposal command can request approval but cannot approve or consume it', async () => {
    const instance = command(RelationshipProposalsRequestApproval);
    const requestRelationshipProposalApproval = jest.fn().mockResolvedValue({
      statusCode: 200,
      data: {
        proposal: {id: 'proposal-1'},
        approval: {id: 'approval-1', status: 'pending'},
        approvalUrl: 'https://siftable.io/app/vault/approvals?approval=approval-1',
      },
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'proposal-1'},
      flags: {purpose: 'Send follow-up', 'idempotency-key': 'stable-approval-001'},
    });
    (instance as any).client = jest.fn().mockResolvedValue({requestRelationshipProposalApproval});
    (instance as any).handleApiError = jest.fn();
    (instance as any).jsonEnabled = () => true;

    const result = await instance.run();

    expect(result).toMatchObject({
      approval: {id: 'approval-1', status: 'pending'},
      approvalUrl: 'https://siftable.io/app/vault/approvals?approval=approval-1',
    });
    expect(requestRelationshipProposalApproval).toHaveBeenCalledWith(
      'proposal-1',
      {purpose: 'Send follow-up'},
      'stable-approval-001',
    );
    expect(existsSync('src/commands/relationships/proposals/approve.ts')).toBe(false);
    expect(existsSync('src/commands/relationships/proposals/consume.ts')).toBe(false);
  });

  test('playbook creation and approval are separate CLI decisions', async () => {
    const create = command(RelationshipPlaybooksCreate);
    const review = command(RelationshipPlaybooksReview);
    const apiRequest = jest.fn()
      .mockResolvedValueOnce({playbook: {snapshot: {playbookVersionId: 'playbook-1'}, latestReview: null}})
      .mockResolvedValueOnce({review: {reviewId: 'review-1', decision: 'approved'}});
    (create as any).parse = jest.fn().mockResolvedValue({flags: {file: jsonFile('playbook.json', {stableKey: 'gap'}), yes: true}});
    (create as any).apiRequest = apiRequest;
    (create as any).confirmAction = jest.fn().mockResolvedValue(true);
    (create as any).jsonEnabled = () => true;
    (review as any).parse = jest.fn().mockResolvedValue({args: {id: 'playbook-1'}, flags: {decision: 'approved', reason: 'Reviewed', yes: true}});
    (review as any).apiRequest = apiRequest;
    (review as any).confirmAction = jest.fn().mockResolvedValue(true);
    (review as any).jsonEnabled = () => true;

    await create.run();
    await review.run();

    expect(apiRequest.mock.calls[0][1]).toBe('/api/v1/relationship-playbooks/playbooks');
    expect(apiRequest.mock.calls[1][1]).toBe('/api/v1/relationship-playbooks/playbooks/playbook-1/reviews');
  });

  test('diagnosis, recommendation, and generation preserve the headless JSON contract', async () => {
    const diagnosis = command(RelationshipDiagnosesCreate);
    const recommend = command(RelationshipPlaybookRecommendationsCreate);
    const generate = command(RelationshipGeneratedAssetsGenerate);
    const apiRequest = jest.fn()
      .mockResolvedValueOnce({diagnosis: {diagnosisId: 'diagnosis-1'}})
      .mockResolvedValueOnce({recommendation: {recommendationId: 'recommendation-1', selectedMoveId: 'diagnose'}})
      .mockResolvedValueOnce({generatedAsset: {snapshot: {generatedAssetId: 'asset-1'}, latestReview: null}});
    for (const [instance, file, value] of [
      [diagnosis, 'diagnosis.json', {currentState: []}],
      [recommend, 'recommendation.json', {moves: [{}, {}, {}]}],
      [generate, 'generation.json', {playbookVersionId: 'playbook-1'}],
    ] as const) {
      (instance as any).parse = jest.fn().mockResolvedValue({flags: {file: jsonFile(file, value), yes: true}});
      (instance as any).apiRequest = apiRequest;
      (instance as any).confirmAction = jest.fn().mockResolvedValue(true);
      (instance as any).jsonEnabled = () => true;
    }

    await diagnosis.run();
    await recommend.run();
    await generate.run();

    expect(apiRequest.mock.calls.map((call) => call[1])).toEqual([
      '/api/v1/relationship-playbooks/diagnoses',
      '/api/v1/relationship-playbooks/recommendations',
      '/api/v1/relationship-playbooks/generated-assets',
    ]);
  });

  test('generated artifact approval remains separate from external draft and send', async () => {
    const review = command(RelationshipGeneratedAssetsReview);
    const draft = command(RelationshipGeneratedAssetsDraft);
    const apiRequest = jest.fn()
      .mockResolvedValueOnce({review: {reviewId: 'review-1', decision: 'approved'}})
      .mockResolvedValueOnce({asset: {snapshot: {generatedAssetId: 'asset-1'}}, action: {proposal: {id: 'proposal-1'}}});
    (review as any).parse = jest.fn().mockResolvedValue({args: {id: 'asset-1'}, flags: {decision: 'approved', reason: 'Content reviewed', yes: true}});
    (review as any).apiRequest = apiRequest;
    (review as any).confirmAction = jest.fn().mockResolvedValue(true);
    (review as any).jsonEnabled = () => true;
    (draft as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'asset-1'},
      flags: {
        file: jsonFile('draft.json', {
          senderAccountId: '55555555-5555-4555-8555-555555555555',
          destination: {channel: 'email', to: ['buyer@example.com']},
          idempotencyKey: 'draft-1',
        }),
        yes: true,
      },
    });
    (draft as any).apiRequest = apiRequest;
    (draft as any).confirmAction = jest.fn().mockResolvedValue(true);
    (draft as any).jsonEnabled = () => true;

    await review.run();
    const result = await draft.run() as {action: {proposal: {id: string}}};

    expect(apiRequest.mock.calls[1][1]).toBe('/api/v1/relationship-playbooks/generated-assets/asset-1/draft');
    expect(result.action.proposal.id).toBe('proposal-1');
    expect(existsSync('src/commands/relationships/generated-assets/send.ts')).toBe(false);
  });

  test('exact source versions, review history, usage, and outcome links remain headless', async () => {
    const sourceShow = command(RelationshipSourceAssetsShow);
    const reviewHistory = command(RelationshipGeneratedAssetsReviewHistory);
    const usageList = command(RelationshipGeneratedAssetsUsageList);
    const usageRecord = command(RelationshipGeneratedAssetsUsageRecord);
    const apiRequest = jest.fn()
      .mockResolvedValueOnce({sourceAsset: {snapshot: {sourceAssetVersionId: 'source-1', version: 4}}})
      .mockResolvedValueOnce({reviews: [{reviewId: 'review-1', decision: 'approved'}]})
      .mockResolvedValueOnce({usage: [{usageId: 'usage-1', kind: 'exported'}]})
      .mockResolvedValueOnce({usage: {usageId: 'usage-2', kind: 'outcome_linked', outcomeRef: 'won:deal-1'}});
    for (const instance of [sourceShow, reviewHistory, usageList]) {
      (instance as any).parse = jest.fn().mockResolvedValue({args: {id: 'asset-1'}, flags: {}});
      (instance as any).apiRequest = apiRequest;
      (instance as any).jsonEnabled = () => true;
    }
    (usageRecord as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'asset-1'},
      flags: {kind: 'outcome_linked', outcome: 'won:deal-1', 'idempotency-key': 'usage-outcome-0001', yes: true},
    });
    (usageRecord as any).apiRequest = apiRequest;
    (usageRecord as any).confirmAction = jest.fn().mockResolvedValue(true);
    (usageRecord as any).jsonEnabled = () => true;

    await sourceShow.run();
    await reviewHistory.run();
    await usageList.run();
    await usageRecord.run();

    expect(apiRequest.mock.calls.map((call) => call[1])).toEqual([
      '/api/v1/relationship-playbooks/source-assets/asset-1',
      '/api/v1/relationship-playbooks/generated-assets/asset-1/reviews',
      '/api/v1/relationship-playbooks/generated-assets/asset-1/usage',
      '/api/v1/relationship-playbooks/generated-assets/asset-1/usage',
    ]);
    expect(apiRequest.mock.calls[3][2]).toMatchObject({
      method: 'POST',
      idempotencyKey: 'usage-outcome-0001',
      body: {kind: 'outcome_linked', outcomeRef: 'won:deal-1', idempotencyKey: 'usage-outcome-0001'},
    });
  });
});
