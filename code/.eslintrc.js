module.exports = {
  // NOTE: previously this file declared `extends` twice, which silently
  // dropped the first value due to JS object-literal semantics. Consolidate
  // into a single array so ESLint actually sees every preset.
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended', // Makes ESLint and Prettier play nicely together
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  ignorePatterns: ['**/dist/*'],
  overrides: [
    {
      files: ['**/*.test.ts'],
      rules: {
        'simple-import-sort/imports': 'off', // for test files we would want to load the mocked up modules later so on sorting the mocking mechanism will not work
      },
    },
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
  },
  plugins: ['prettier', 'unused-imports', 'import', 'simple-import-sort', 'sort-keys-fix'],
  root: true,
  rules: {
    // Slack and DevRev event payloads are dynamically-typed JSON; the
    // codebase uses `any` deliberately for those shapes plus the catch-
    // block error variables. Disabling the rule keeps the lint summary
    // clean. New code that wants stronger typing should reach for
    // `Record<string, unknown>` + the helpers in utils/errors.ts.
    '@typescript-eslint/no-explicit-any': 'off',
    // Permit `_`-prefixed names as intentionally unused (TS convention).
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'import/first': 'error',

    // Ensures all imports are at the top of the file
    'import/newline-after-import': 'error',

    // Ensures there’s a newline after the imports
    'import/no-duplicates': 'error',

    // Merges import statements from the same file
    'import/order': 'off',

    // Not compatible with simple-import-sort
    'no-unused-vars': 'off',

    // Handled by @typescript-eslint/no-unused-vars
    'simple-import-sort/exports': 'error',

    // Auto-formats exports
    'simple-import-sort/imports': 'error',

    // Auto-formats imports
    'sort-imports': 'off',

    // Not compatible with simple-import-sort
    'sort-keys-fix/sort-keys-fix': ['error', 'asc', { natural: true }],

    // Sorts long object key lists alphabetically
    'unused-imports/no-unused-imports': 'error',
  },
};
