// @ts-check
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/** Node built-ins and I/O modules. The engine must run in a browser. */
const IO_MODULES = [
  'node:*',
  'fs',
  'fs/*',
  'path',
  'os',
  'child_process',
  'http',
  'https',
  'net',
  'crypto',
  'process',
  'worker_threads',
];

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'sims/output/**', 'data/**', 'coverage/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Scaffold stubs name their parameters with a leading underscore.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Boundary: the engine is pure. No I/O, no clocks, no ambient randomness,
  // no chrome, and no imports from other workspace packages.
  {
    files: ['engine/src/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: IO_MODULES, message: 'engine/ does no I/O and must run in a browser.' },
            {
              group: ['@league-of-taverns/*', '**/bots/**', '**/scripts/**', '**/sims/**', '**/explorer/**'],
              message: 'engine/ depends on nothing else in this repo.',
            },
            {
              group: ['**/chrome/**', '**/characters/*/**', '**/*.yaml', '**/*.md'],
              message: 'engine/ never reads chrome or authored files. Callers pass parsed, chrome-free data in.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'engine/ does no I/O.' },
        { name: 'fetch', message: 'engine/ does no I/O.' },
        { name: 'window', message: 'engine/ must not depend on a DOM.' },
        { name: 'document', message: 'engine/ must not depend on a DOM.' },
        { name: 'localStorage', message: 'engine/ does no I/O.' },
        { name: 'Date', message: 'engine/ is deterministic. Pass timestamps in as ISO strings.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use rngFor(seed, key) from engine/src/rng.' },
        // Implementation-approximated in ECMAScript: results differ across JS engines.
        ...['exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'cbrt', 'hypot'].map(
          (property) => ({ object: 'Math', property, message: 'Not bit-identical across JS engines. Use engine/src/internal/det-math.' }),
        ),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: '** is Math.pow under the hood. Use detExp/detLn or repeated multiplication.' },
      ],
    },
  },

  // The sims playground runs in a browser (it may import the engine, unlike explorer/).
  {
    files: ['sims/src/playground/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Boundary: the explorer reads only published JSON.
  {
    files: ['explorer/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@league-of-taverns/*', '**/engine/**'], message: 'explorer/ reads only published JSON.' },
          ],
        },
      ],
    },
  },
);
