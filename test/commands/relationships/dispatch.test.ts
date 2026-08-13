import RelationshipsComposerDispatch from '../../../src/commands/relationships/composer/dispatch';

function command(): RelationshipsComposerDispatch {
  return Object.create(RelationshipsComposerDispatch.prototype) as RelationshipsComposerDispatch;
}

describe('relationships composer dispatch command', () => {
  it('sends one exact scheduled choice with its optimistic version and idempotency key', async () => {
    const instance = command();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const apiRequest = jest.fn().mockResolvedValue({
      dispatch: {
        current: { status: 'scheduled', actionId: 'relationship.communication.send' },
        receipts: [{ status: 'scheduled', choice: 'send_later' }],
        outcomes: [],
      },
    });
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: { id: sessionId },
      flags: {
        choice: 'send_later',
        at: '2026-08-12T14:00:00.000Z',
        'expected-version': 7,
        'idempotency-key': 'composer-dispatch-0001',
        yes: true,
      },
    });
    (instance as any).apiRequest = apiRequest;
    (instance as any).confirmAction = jest.fn().mockResolvedValue(true);
    (instance as any).jsonEnabled = () => true;

    await expect(instance.run()).resolves.toMatchObject({ current: { status: 'scheduled' } });
    expect(apiRequest).toHaveBeenCalledWith(
      expect.anything(),
      `/api/v1/relationships/composer-sessions/${sessionId}/dispatches`,
      {
        method: 'POST',
        body: {
          expectedVersion: 7,
          idempotencyKey: 'composer-dispatch-0001',
          choice: 'send_later',
          scheduledFor: '2026-08-12T14:00:00.000Z',
        },
      },
    );
  });

  it('does not accept a schedule for approve-only or send-now', async () => {
    const instance = command();
    (instance as any).parse = jest.fn().mockResolvedValue({
      args: { id: '11111111-1111-4111-8111-111111111111' },
      flags: {
        choice: 'send_now',
        at: '2026-08-12T14:00:00.000Z',
        'expected-version': 7,
        'idempotency-key': 'composer-dispatch-0002',
        yes: true,
      },
    });

    await expect(instance.run()).rejects.toThrow('--at is only valid with --choice send_later');
  });
});
