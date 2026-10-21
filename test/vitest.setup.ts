import { vi } from 'vitest';

// Jest-compat shim: the suite is written against the `jest.*` API and runs under
// both runners (jest is the canonical `test` script; vitest is `test:vitest`).
// Only the APIs the suite actually uses are mapped (per a full `jest.<api>`
// survey: fn, spyOn, mock, *AllMocks, fake timers, and a setTimeout no-op). The
// mappings match the Vitest "Migrating from Jest" table 1:1, except where noted.
//
// jest.mock → vi.mock: NOT statically hoisted the way babel-jest hoists jest.mock,
// but that is safe here because every jest.mock call in the suite precedes the
// require() of the module it mocks (no static-import race). A module-mock file
// that ever relies on hoisting must use a literal vi.mock instead.

// Jest's fake-timer config names the APIs to leave real (`doNotFake`); Vitest's
// names the ones to fake (`toFake`). Both runners use the same 15 names, so the
// shim translates one list into the other.
const FAKEABLE = [
  'Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
] as const;
type Fakeable = (typeof FAKEABLE)[number];

Object.defineProperty(globalThis, 'jest', {
  configurable: true,
  value: {
    fn: vi.fn,
    spyOn: vi.spyOn,
    mock: vi.mock,
    unmock: vi.unmock,
    doMock: vi.doMock,
    mocked: vi.mocked,
    clearAllMocks: vi.clearAllMocks,
    resetAllMocks: vi.resetAllMocks,
    restoreAllMocks: vi.restoreAllMocks,
    resetModules: vi.resetModules,
    useFakeTimers: (config?: {doNotFake?: readonly Fakeable[]}) => vi.useFakeTimers(config?.doNotFake
      ? {toFake: FAKEABLE.filter((name) => !config.doNotFake?.includes(name))}
      : undefined),
    useRealTimers: () => vi.useRealTimers(),
    advanceTimersByTimeAsync: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    // Per-test timeout is set in vitest.config.ts (testTimeout); jest's global
    // setTimeout has no vi equivalent, so it's a no-op under vitest.
    setTimeout: () => undefined,
  },
});
