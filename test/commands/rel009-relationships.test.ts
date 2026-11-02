import RelationshipActionsRun from '../../src/commands/relationships/actions/run.js';

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

describe('REL-009 CLI relationship surface', () => {
  test('preserves the canonical action, input, result, and caller receipt', async () => {
    const instance = command(RelationshipActionsRun);
    const result = {
      actionId: 'relationship.next_action.set',
      entity: {kind: 'opportunity', id: '90000000-0000-4000-8000-000000000015'},
      status: 'applied',
      result: {
        nextAction: {
          id: '90000000-0000-4000-8000-000000000014',
          title: 'Confirm the buying group and evaluation date',
          dueAt: '2026-08-05T16:00:00.000Z',
          status: 'pending',
        },
      },
    };
    const apiRequest = jest.fn().mockResolvedValue({result});
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: {
        id: 'relationship.next_action.set',
        entity: 'opportunity:90000000-0000-4000-8000-000000000015',
      },
      flags: {
        input: JSON.stringify({
          title: 'Confirm the buying group and evaluation date',
          dueAt: '2026-08-05T16:00:00.000Z',
          source: 'rel009_release_proof',
        }),
        'idempotency-key': 'rel009-next-action-0001',
        yes: true,
      },
    });
    (instance as any).apiRequest = apiRequest;
    (instance as any).confirmAction = jest.fn().mockResolvedValue(true);
    (instance as any).jsonEnabled = () => true;

    await expect(instance.run()).resolves.toEqual(result);
    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({'idempotency-key': 'rel009-next-action-0001'}),
      '/api/v1/ontology/relationship-actions/run',
      expect.objectContaining({
        method: 'POST',
        idempotencyKey: 'rel009-next-action-0001',
        body: expect.objectContaining({
          actionId: 'relationship.next_action.set',
          entity: {kind: 'opportunity', id: '90000000-0000-4000-8000-000000000015'},
        }),
      }),
    );
    expect((RelationshipActionsRun.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
  });

  test('does not offer approval bypass flags', () => {
    expect(RelationshipActionsRun.flags).not.toHaveProperty('approval');
    expect(RelationshipActionsRun.flags).not.toHaveProperty('approve');
    expect(RelationshipActionsRun.flags).not.toHaveProperty('execute-locally');
  });
});
