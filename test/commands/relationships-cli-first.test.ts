import {existsSync} from 'node:fs';
import RelationshipActionsRun from '../../src/commands/relationships/actions/run.js';
import RelationshipActionsDryRun from '../../src/commands/relationships/actions/dry-run.js';
import RelationshipSequencesCreate from '../../src/commands/relationships/sequences/create.js';
import RelationshipSequencesUpdate from '../../src/commands/relationships/sequences/update.js';
import RelationshipSequencesEnroll from '../../src/commands/relationships/sequences/enroll.js';
import RelationshipSequencesPause from '../../src/commands/relationships/sequences/pause.js';
import RelationshipSequencesResume from '../../src/commands/relationships/sequences/resume.js';
import RelationshipSequencesDryRun from '../../src/commands/relationships/sequences/dry-run.js';
import RelationshipProposalsRequestApproval from '../../src/commands/relationships/proposals/request-approval.js';

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

describe('relationship CLI-first adapters', () => {
  test('action run passes the exact stable idempotency key to the client', async () => {
    const instance = command(RelationshipActionsRun);
    const runRelationshipAction = jest.fn().mockResolvedValue({
      statusCode: 200,
      data: {execution: {id: 'execution-1', outcome: 'proposed'}},
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'relationship.communication.send'},
      flags: {input: '{"personId":"person-1"}', 'idempotency-key': 'stable-action-001'},
    });
    (instance as any).client = jest.fn().mockResolvedValue({runRelationshipAction});
    (instance as any).handleApiError = jest.fn();
    (instance as any).unwrapOne = (response: any, key: string) => response.data[key];
    (instance as any).jsonEnabled = () => true;

    await instance.run();

    expect(runRelationshipAction).toHaveBeenCalledWith(
      'relationship.communication.send',
      {personId: 'person-1'},
      'stable-action-001',
    );
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
      {},
      'stable-preview-001',
    );
    expect(RelationshipActionsDryRun.flags).not.toHaveProperty('approval');
    expect(RelationshipActionsDryRun.flags).not.toHaveProperty('execute-locally');
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
      data: {proposal: {id: 'proposal-1'}, approval: {id: 'approval-1', status: 'pending'}},
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {id: 'proposal-1'},
      flags: {purpose: 'Send follow-up', 'idempotency-key': 'stable-approval-001'},
    });
    (instance as any).client = jest.fn().mockResolvedValue({requestRelationshipProposalApproval});
    (instance as any).handleApiError = jest.fn();
    (instance as any).jsonEnabled = () => true;

    const result = await instance.run();

    expect(result).toMatchObject({approval: {id: 'approval-1', status: 'pending'}});
    expect(requestRelationshipProposalApproval).toHaveBeenCalledWith(
      'proposal-1',
      {purpose: 'Send follow-up'},
      'stable-approval-001',
    );
    expect(existsSync('src/commands/relationships/proposals/approve.ts')).toBe(false);
    expect(existsSync('src/commands/relationships/proposals/consume.ts')).toBe(false);
  });
});
