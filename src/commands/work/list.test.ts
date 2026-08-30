import {describe, expect, it, vi} from 'vitest';
import WorkList from './list.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('work list collection contract', () => {
  it('matches the backend collection bound and returns the standard envelope', async () => {
    expect(WorkList.flags.limit).toEqual(expect.objectContaining({default: 50, min: 1, max: 200}));
    const list = command(WorkList);
    const listWorkItems = vi.fn().mockResolvedValue({
      data: {workItems: [{id: 'work-1', title: 'Fix contract', claimToken: 'secret'}]},
    });
    (list as any).parse = vi.fn().mockResolvedValue({flags: {limit: 1}});
    (list as any).client = vi.fn().mockResolvedValue({listWorkItems});
    (list as any).handleApiError = vi.fn();
    (list as any).unwrapList = (response: any) => response.data.workItems;
    (list as any).jsonEnabled = () => true;

    const result = await list.run();

    expect(result).toEqual({
      ok: true,
      workItems: [{id: 'work-1', title: 'Fix contract'}],
      page: {returned: 1, nextCursor: null, total: null, complete: false, snapshotId: null},
      omissions: ['totalCount', 'continuationCursor'],
      warnings: [
        'The collection may contain more results, but no safe continuation cursor is available. Narrow filters or raise the limit.',
      ],
    });
  });
});
