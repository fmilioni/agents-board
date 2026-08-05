// @ts-check
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Lint config for the Node/TS backend packages (shared, db, core, mcp, api).
// The web package has its own Nuxt-based config (packages/web/eslint.config.mjs)
// and is ignored here.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/node_modules/**',
      'packages/web/**',
      'packages/db/migrations/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  stylistic.configs.customize({
    quotes: 'single',
    semi: false,
    commaDangle: 'never',
    braceStyle: '1tbs'
  }),
  {
    plugins: {
      'simple-import-sort': simpleImportSort
    },
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-warning-comments': ['error', { terms: ['TODO', 'FIXME', 'XXX', 'HACK'], location: 'anywhere' }],
      'simple-import-sort/exports': 'error',
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            // Side-effect imports.
            ['^\\u0000'],
            // Node.js builtins.
            ['^node:'],
            // External packages.
            ['^'],
            // Internal workspace packages.
            ['^@agents-board/'],
            // Relative imports.
            ['^\\.']
          ]
        }
      ]
    }
  }
)
