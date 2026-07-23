import {existsSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import ApprovalsRequest from './request.js';
import ApprovalsStatus from './status.js';

describe('governed approval CLI surface', () => {
  it('can request and inspect but exposes no approve or consume command', async () => {
    const requestCommand = Object.create(ApprovalsRequest.prototype) as ApprovalsRequest;
    const requestApi = vi.fn().mockResolvedValue({
      approval: {
        id: 'approval-1',
        status: 'pending',
        expiresAt: '2026-07-23T22:00:00.000Z',
      },
    });
    (requestCommand as any).parse = vi.fn().mockResolvedValue({
      flags: {
        action: 'vault.materialize',
        purpose: 'Write to an approved path',
        'resource-type': 'vault_entry',
        'resource-id': 'entry-1',
        operation: 'write_file',
        destination: '{"path":"/tmp/example"}',
      },
    });
    (requestCommand as any).apiRequest = requestApi;
    (requestCommand as any).jsonEnabled = () => true;
    (requestCommand as any).log = vi.fn();

    const requested = await requestCommand.run();
    expect(requested).toMatchObject({id: 'approval-1', status: 'pending'});
    expect(requestApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/governed-approvals',
      expect.objectContaining({
        body: expect.objectContaining({
          surface: 'cli',
          destination: {path: '/tmp/example'},
        }),
      }),
    );

    const statusCommand = Object.create(ApprovalsStatus.prototype) as ApprovalsStatus;
    const statusApi = vi.fn().mockResolvedValue({
      approval: {
        id: 'approval-1',
        status: 'approved',
        action: 'vault.materialize',
        resourceType: 'vault_entry',
        resourceId: 'entry-1',
        expiresAt: '2026-07-23T22:00:00.000Z',
      },
    });
    (statusCommand as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'approval-1'},
      flags: {},
    });
    (statusCommand as any).apiRequest = statusApi;
    (statusCommand as any).jsonEnabled = () => true;
    (statusCommand as any).log = vi.fn();

    const status = await statusCommand.run();
    expect(status).toMatchObject({id: 'approval-1', status: 'approved'});
    expect(statusApi.mock.calls[0][1]).toContain('surface=cli');
    expect(JSON.stringify({requested, status})).not.toContain('approvalToken');

    expect(existsSync('src/commands/approvals/approve.ts')).toBe(false);
    expect(existsSync('src/commands/approvals/consume.ts')).toBe(false);
  });
});
