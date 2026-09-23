import { realpathSync } from 'node:fs';
import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// The Obsidian community directory reviews every release with
// eslint-plugin-obsidianmd (pinned to the scanner's version in package.json).
// Its `recommended` config is the base here, so `pnpm lint` reports what the
// scanner will. The scanner itself only reads plugin source: it skips tests,
// scripts, `*.mjs` and `src/i18n/**`, and it demotes everything but six
// security rules to warnings. We lint all of it, at the recommended
// severities, and switch off below only what cannot apply outside the plugin
// runtime.
//
// eslint-plugin-obsidianmd reads `manifest.json` from the *current directory*
// (`minAppVersion` for no-unsupported-api, `isDesktopOnly` for the Node
// globals). Run from anywhere else, it silently checks against another
// manifest or none — so refuse to. `pnpm lint`, lint-staged and CI all run
// from the plugin root.
const pluginRoot = realpathSync.native(import.meta.dirname);
const cwd = realpathSync.native(process.cwd());
const sameDir =
  process.platform === 'win32'
    ? pluginRoot.toLowerCase() === cwd.toLowerCase()
    : pluginRoot === cwd;
if (!sameDir) {
  throw new Error(
    `Run ESLint from ${pluginRoot}: eslint-plugin-obsidianmd reads manifest.json from the current directory (${cwd}).`,
  );
}

/** Every obsidianmd rule, off — for code that never runs inside Obsidian. */
const obsidianmdRulesOff = Object.fromEntries(
  [
    ...Object.keys(obsidianmd.ruleConfigs.recommended),
    ...Object.keys(obsidianmd.ruleConfigs.recommendedTypeChecked),
    'obsidianmd/rule-custom-message',
  ].map((rule) => [rule, 'off']),
);

export default defineConfig([
  globalIgnores(['node_modules/**', 'main.js', 'build/**', 'dist/**', 'coverage/**', '*.min.js']),

  ...obsidianmd.configs.recommended,

  {
    // Type information for the type-checked rules. `tsconfig.json` covers
    // src/, tests/ and scripts/; plain `.mjs` files get the untyped rule set.
    files: ['**/*.{ts,tsx,cts,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // Kept from the pre-obsidianmd config: stricter than the recommended
    // `warn` + `args: 'none'`, with `_`-prefixed names as the opt-out.
    files: ['**/*.{ts,tsx,cts,mts,js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // validate-manifest only fires on a file named `manifest.json`, and the
    // recommended config lints no JSON but package.json. The TypeScript parser
    // reads a `.json` file as one object expression — the shape the rule
    // walks.
    files: ['manifest.json'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'obsidianmd/validate-manifest': 'error',
    },
  },

  {
    // lint-staged stays: a dev-only pre-commit tool that never reaches the
    // bundle (decision for 0.3.5). The scanner still lists it as a warning;
    // `allowed` keeps any *new* banned dependency an error here.
    files: ['package.json'],
    rules: {
      'depend/ban-dependencies': [
        'error',
        { presets: ['native', 'microutilities', 'preferred'], allowed: ['lint-staged'] },
      ],
    },
  },

  {
    // Jest globals.
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
  },

  {
    // Tests run under Jest in Node, never in an Obsidian window: popout-window
    // timers and globals (the Node global object *is* `window` there — see
    // tests/setup-window.ts), the config-folder literal (the path filters are
    // tested *with* `.obsidian`) and UI sentence case have nothing to check.
    files: ['tests/**'],
    rules: {
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/no-global-this': 'off',
      'obsidianmd/hardcoded-config-path': 'off',
      'obsidianmd/ui/sentence-case': 'off',
    },
  },

  {
    // Node CLIs and build/release tooling: they print to the terminal and run
    // outside Obsidian, so none of the plugin-runtime rules apply.
    files: ['scripts/**', '*.mjs'],
    rules: obsidianmdRulesOff,
  },

  prettier,
]);
