import {describe, expect, it, vi} from 'vitest';
import CrmOrganizationsList from './list.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('CRM organization discovery', () => {
  it('excludes workspace shells and sends the selected tenant to CRM discovery', async () => {
    const instance = command(CrmOrganizationsList);
    const apiRequest = vi.fn().mockResolvedValue({
      organizations: [
        {id: 'crm-1', name: 'Customer', isWorkspace: false},
        {id: 'workspace-1', name: 'Collaborative tenant', isWorkspace: true},
      ],
    });
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {
      workspace: 'workspace-1',
      limit: 100,
    }});
    (instance as any).apiRequest = apiRequest;
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(apiRequest.mock.calls[0][0]).toMatchObject({workspace: 'workspace-1'});
    expect(result.organizations).toEqual([{id: 'crm-1', name: 'Customer', isWorkspace: false}]);
    expect(result.excludedWorkspaceCount).toBe(1);
  });
});
