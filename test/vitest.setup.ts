import { vi } from 'vitest';

// Jest-compat shim: the suite is written against the `jest.*` API and runs under
// both runners (jest is the canonical `test` script; vitest is `test:vitest`).
// Only the APIs the suite actually uses are mapped (per a full `jest.<api>`
// survey: fn, spyOn, mock, *AllMocks, and a setTimeout no-op). The mappings match
// the Vitest "Migrating from Jest" table 1:1.
//
// jest.mock → vi.mock: NOT statically hoisted the way babel-jest hoists jest.mock,
// but that is safe here because every jest.mock call in the suite precedes the
// require() of the module it mocks (no static-import race). A module-mock file
// that ever relies on hoisting must use a literal vi.mock instead.
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
    // Per-test timeout is set in vitest.config.ts (testTimeout); jest's global
    // setTimeout has no vi equivalent, so it's a no-op under vitest.
    setTimeout: () => undefined,
  },
});
