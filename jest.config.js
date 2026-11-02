module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // These suites are authored Vitest-native (vi mocks/imports); they run under
  // `test:vitest`, not Jest.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/test/commands/interactive.chat-agent.test.ts',
    '<rootDir>/test/commands/vault-containment.test.ts',
    '<rootDir>/test/commands/vault-scopes.test.ts',
    '<rootDir>/test/compute-commands.test.ts',
    '<rootDir>/test/env-commands.test.ts',
    '<rootDir>/test/environmentCheckoutSafety.test.ts',
    '<rootDir>/test/environmentManifest.test.ts',
    '<rootDir>/test/environmentState.test.ts',
    '<rootDir>/test/dotenvImport.test.ts',
    '<rootDir>/test/dotenvImportCommands.test.ts',
    '<rootDir>/test/envCsvImport.test.ts',
    '<rootDir>/test/envCsvImportCommands.test.ts',
    '<rootDir>/test/envImportCleanupCommand.test.ts',
    '<rootDir>/test/envContractExportCommand.test.ts',
    '<rootDir>/test/error-exit-contract.test.ts',
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/generated/**',
    '!src/**/__mocks__/**',
    '!src/**/*.{test,spec,vitest}.*',
  ],
  coverageDirectory: '<rootDir>/coverage/jest',
  coverageReporters: ['lcov', 'json', 'json-summary'],
  moduleNameMapper: {
    '^.*?/packages/exf-cli/dist/(.*)\\.js$': '<rootDir>/src/$1.ts',
    '^\\.\\./dist/lib/daily-review-context\\.js$': '<rootDir>/src/lib/daily-review-context.ts',
    '^@siftable/mcp-server/dist/exfClient\\.js$': '<rootDir>/../exf-mcp-server/src/exfClient.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Runtime transpilation is deliberately independent from the authoritative
    // Node16/Bundler typecheck configs. See test/importMetaTransformer.cjs.
    '^.+\\.ts$': '<rootDir>/test/importMetaTransformer.cjs',
  },
};
