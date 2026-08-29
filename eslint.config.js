// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'docs/'] },
  js.configs.recommended,
  // Type-aware rather than syntactic. The syntactic preset cannot see that a
  // value came from `unknown`, and this codebase reads a lot of upstream JSON:
  // no-unsafe-assignment and no-unsafe-member-access are the rules that make an
  // unchecked cast of an API response visible.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json, not tsconfig.json: the latter builds dist/ and
        // therefore includes only src/, which would leave every file under
        // test/ without type information and unparseable to these rules.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain-JavaScript build scripts. The TypeScript sources get `process` and
    // `console` from tsconfig's "types": ["node"]; a .mjs file has no such
    // declaration, so the globals are named here instead of pulling in the
    // whole `globals` package for two of them.
    files: ['scripts/**/*.mjs'],
    // The type-aware rules are switched off here rather than made to pass. These
    // files are deliberately outside tsconfig.test.json — they are build tooling,
    // not shipped code — so the type checker sees no declarations for them and
    // every expression reads as `any`. That produces dozens of no-unsafe-*
    // errors that say nothing about the script and would only be silenced by
    // annotating plain JavaScript into submission. js.configs.recommended still
    // applies, so real mistakes are still caught.
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    // A fetch stub has to hand back a promise, and `async () => new Response()`
    // is the readable way to write one — there is nothing to await inside it.
    // The same shape appears wherever a test drives `run()`, whose callback is
    // async by signature. The rule is right about production code and wrong
    // about both of these.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  }
);
