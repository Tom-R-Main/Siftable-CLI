import { vi } from 'vitest';

Object.defineProperty(globalThis, 'jest', {
  configurable: true,
  value: {
    fn: vi.fn,
    clearAllMocks: vi.clearAllMocks,
    resetAllMocks: vi.resetAllMocks,
    restoreAllMocks: vi.restoreAllMocks,
  },
});
