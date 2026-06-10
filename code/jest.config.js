module.exports = {
  // Collect coverage from all source files (functions, utils, and top-level config/logger).
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/main.ts',       // CLI entry point — not meaningful to unit-test
    '!src/index.ts',      // Barrel re-export
    '!src/test-runner/**',
  ],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Output both a human-readable table and an lcov report for CI tooling.
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    // Global 40% branch threshold — applies across all collected files
    // combined, not per-file. Tightened incrementally as the test suite grows.
    global: {
      branches: 40,
    },
  },
  preset: 'ts-jest',
  // Load .env before any test so env-var driven config constants resolve correctly.
  setupFiles: ['dotenv/config'],
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
