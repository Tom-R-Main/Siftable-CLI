import {describe, expect, it, vi} from 'vitest';
import {listenForMobileWork} from './mobile-work-listener';

describe('mobile work listener recovery', () => {
  it('backs off across failed polls, caps the delay, and resets after a successful poll', async () => {
    const stop = new Error('test finished');
    const poll = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), {statusCode: 503}))
      .mockRejectedValueOnce(Object.assign(new Error('expired lease'), {statusCode: 409}))
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), {statusCode: 429}))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), {statusCode: 503}))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), {statusCode: 503}))
      .mockResolvedValueOnce('idle')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(stop);
    const wait = vi.fn(async (_delayMs: number) => {});
    const onRetry = vi.fn();
    await expect(listenForMobileWork({poll, once: false, wait, onRetry})).rejects.toBe(stop);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 5000, 5000]);
    expect(onRetry).toHaveBeenCalledTimes(7);
  });

  it.each([401, 403, 400])('does not retry an HTTP %s failure', async statusCode => {
    const error = Object.assign(new Error('requires intervention'), {statusCode});
    const wait = vi.fn();
    await expect(listenForMobileWork({poll: async () => {throw error;}, once: false, wait, onRetry: vi.fn()})).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it('preserves --once failure and success behavior', async () => {
    const error = new TypeError('fetch failed');
    const wait = vi.fn();
    await expect(listenForMobileWork({poll: async () => {throw error;}, once: true, wait, onRetry: vi.fn()})).rejects.toBe(error);
    await expect(listenForMobileWork({poll: async () => 'reviewed', once: true, wait, onRetry: vi.fn()})).resolves.toBe('reviewed');
    expect(wait).not.toHaveBeenCalled();
  });
});
