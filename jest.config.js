module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // interactive.chat-agent is authored vitest-native (hoisted vi.mock + async
  // importActual); it runs under `test:vitest`, not jest. See that file's header.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/commands/interactive.chat-agent.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Wraps ts-jest to rewrite the TUI's Bun/ESM `import.meta.url` into a
    // CommonJS-safe form before compilation. See test/importMetaTransformer.cjs.
    '^.+\\.ts$': '<rootDir>/test/importMetaTransformer.cjs',
  },
};
