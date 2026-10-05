import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'artifacts/**',
      'tests/demo-app/**',
      // Throwaway probes and measurement harnesses. Gitignored (`/scratch/`), so
      // linting them gates a commit on files no commit can contain — and the first
      // thing one does is `console.log` a number, which this config forbids by
      // design everywhere it matters.
      'scratch/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Mirror tsconfig.base.json. Without these, consistent-type-imports cannot see that a
      // Nest constructor parameter's type is a runtime DI token, and its autofix to
      // `import type` would erase the metadata injection depends on.
      parserOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        document: 'readonly',
        window: 'readonly',
        CSS: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        Element: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    /**
     * PRODUCTION CODE DOES NOT IMPORT FROM `tests/`.
     *
     * `tests/support/xlsx-fixture.ts` builds a workbook, and there is no xlsx
     * WRITER in production deliberately: the QA's workbook is read and never
     * written (E5), and a writer reachable from `packages/` is one import away
     * from someone "just updating the Status column".
     *
     * The scope was MEASURED before the rule was added — 99 files under these
     * three directories, none importing from `tests/` — so this pins a property
     * that already held rather than announcing a cleanup. A rule added to fix
     * nothing is still worth having: it is the difference between a property and
     * a habit.
     *
     * `allowTypeImports` is deliberately NOT set. A type-only import creates no
     * runtime edge, but it does create a dependency the next person will widen
     * into a value import, and the boundary is cheaper to hold than to restore.
     */
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tests/*', '**/tests/**', '../tests/*', '../../tests/*'],
              message:
                'Production code must not import from tests/. Test helpers live there on purpose — ' +
                'see tests/support/xlsx-fixture.ts for why there is no xlsx writer in packages/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Specs read better with a little more freedom.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);

/**
 * THE CROSS-APPLICATION IMPORT BOUNDARY IS NOT HERE, AND THAT IS A MEASUREMENT.
 *
 * `tests/apps/<x>/` must never import `tests/apps/<y>/`, and the first attempt was a
 * `no-restricted-imports` block above this one. A planted violation —
 * `tests/apps/other/probe.spec.ts` importing `../dms/pages/admin/admin-list.page` —
 * was NOT caught, which is what the planted control exists to find.
 *
 * The reason is structural: `no-restricted-imports` matches the literal import
 * SOURCE STRING, so it cannot tell `../dms/…` (out of one application, into
 * another) from `../pages/…` (within one). Both are `../<segment>/…` and the rule
 * has no idea how deep the importing file sits. `eslint-plugin-import`'s
 * `no-restricted-paths` is path-aware and would express it; it is not installed.
 *
 * So the boundary is a scanning test instead — `tests/unit/app-suite-scope.spec.ts`
 * — which resolves each import against the importing file and compares application
 * directories. Same mechanism as `no-unscrubbed-spawn.spec.ts` and
 * `app-agnostic.spec.ts`, used here for the same reason: the question needs a
 * resolved path, and a linter matching strings cannot answer it.
 */
