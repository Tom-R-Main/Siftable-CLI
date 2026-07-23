import {describe, expect, it, vi} from 'vitest';
import CapabilitiesList from './list.js';
import CapabilitiesDescribe from './describe.js';
import CapabilitiesExecute from './execute.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('Vault capability CLI surface', () => {
  it('provides list, describe, and typed execute parity without Vault plaintext output', async () => {
    const list = command(CapabilitiesList);
    const listApi = vi.fn().mockResolvedValue({
      capabilities: [{
        id: 'capability-1',
        adapterId: 'google_ai_studio',
        allowedOperations: ['generate_content'],
        revokedAt: null,
      }],
    });
    (list as any).parse = vi.fn().mockResolvedValue({flags: {}});
    (list as any).apiRequest = listApi;
    (list as any).jsonEnabled = () => true;
    (list as any).log = vi.fn();
    const listed = await list.run();
    expect(listApi.mock.calls[0][1]).toContain('surface=cli');

    const describeCommand = command(CapabilitiesDescribe);
    const describeApi = vi.fn().mockResolvedValue({
      capability: {
        id: 'capability-1',
        adapterId: 'google_ai_studio',
        provider: 'google_ai_studio',
        allowedOperations: ['generate_content'],
        purpose: 'Summarize the corpus',
        expiresAt: '2026-07-24T00:00:00.000Z',
        approvalRequired: true,
      },
    });
    (describeCommand as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'capability-1'},
      flags: {},
    });
    (describeCommand as any).apiRequest = describeApi;
    (describeCommand as any).jsonEnabled = () => true;
    (describeCommand as any).log = vi.fn();
    const described = await describeCommand.run();

    const execute = command(CapabilitiesExecute);
    const executeApi = vi.fn().mockResolvedValue({
      receipt: {
        executionId: 'execution-1',
        resultClass: 'provider_success',
        result: {text: 'bounded answer'},
        reused: false,
      },
    });
    (execute as any).parse = vi.fn().mockResolvedValue({
      flags: {
        handle: 'vcap_opaque',
        operation: 'generate_content',
        input: '{"model":"gemini-3.5-flash","prompt":"hello"}',
        approval: 'approval-1',
        'idempotency-key': 'stable-request-1',
      },
    });
    (execute as any).apiRequest = executeApi;
    (execute as any).jsonEnabled = () => true;
    (execute as any).log = vi.fn();
    const receipt = await execute.run();

    expect(executeApi).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/vault/capabilities/execute',
      expect.objectContaining({
        body: {
          surface: 'cli',
          handle: 'vcap_opaque',
          operation: 'generate_content',
          input: {model: 'gemini-3.5-flash', prompt: 'hello'},
          approvalId: 'approval-1',
          idempotencyKey: 'stable-request-1',
        },
      }),
    );
    expect(JSON.stringify({listed, described, receipt})).not.toContain('SENTINEL_SECRET');
    expect(JSON.stringify({listed, described})).not.toContain('handleSecretHash');
  });
});
