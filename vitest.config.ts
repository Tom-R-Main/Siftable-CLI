import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/generated/**',
        'src/**/__mocks__/**',
        'src/**/*.test.*',
        'src/**/*.spec.*',
        'src/**/*.vitest.*',
      ],
      reporter: ['lcov', 'json', 'json-summary'],
      reportsDirectory: './coverage/vitest',
    },
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // These suites rely on synchronous Jest module isolation (jest.isolateModules,
    // jest.requireActual, jest.dontMock) to reload the fs engine against fake native
    // bindings. Vitest has no synchronous equivalent; they run under `test` (jest),
    // mirroring jest.config.js testPathIgnorePatterns for vitest-native suites.
    exclude: [
      ...configDefaults.exclude,
      'test/commands/interactive.fs-engine.mutation.test.ts',
      'test/commands/interactive.search-completeness.test.ts',
    ],
    setupFiles: ['test/vitest.setup.ts'],
    pool: 'forks',
    // DB/git tests share process cwd and config dirs
    // (test/helpers/config-env.ts). Keep this project serial.
    fileParallelism: false,
    // Match the jest setup's jest.setTimeout(30000) — some DB/git tests need it.
    testTimeout: 30000,
  },
});
