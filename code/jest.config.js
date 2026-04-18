module.exports = {
  collectCoverage: true,
  collectCoverageFrom: [
    'src/functions/**/*.ts',
    'src/utils/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
  ],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],
  coverageReporters: ['text'],
  coverageThreshold: {
    '**/*': {
      branches: 40,
    },
  },
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],
};
