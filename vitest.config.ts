import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    // Match the jest setup's jest.setTimeout(30000) — some DB/git tests need it.
    testTimeout: 30000,
  },
});
