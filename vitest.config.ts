import { defineConfig } from 'vitest/config';

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
    setupFiles: ['test/vitest.setup.ts'],
    pool: 'forks',
    // DB/git tests share process cwd and config dirs
    // (test/helpers/config-env.ts). Keep this project serial.
    fileParallelism: false,
    // Match the jest setup's jest.setTimeout(30000) — some DB/git tests need it.
    testTimeout: 30000,
  },
});
