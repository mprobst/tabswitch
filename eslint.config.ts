import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/*.js', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Braces for if/else whose body spans lines; single-line ifs may omit them.
      curly: ['error', 'multi-line', 'consistent'],
      // chrome.*.addListener callbacks are async; Chrome ignores their result.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test runs these itself; awaiting them isn't needed.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'test', 'it'] },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Config files aren't part of a tsconfig project.
    files: ['*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
