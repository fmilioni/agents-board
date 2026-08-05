// @ts-check
import simpleImportSort from 'eslint-plugin-simple-import-sort'

import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  plugins: {
    'simple-import-sort': simpleImportSort
  },
  rules: {
    'vue/no-multiple-template-root': 'off',
    'vue/max-attributes-per-line': ['error', { singleline: 3 }],
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
          // Internal workspace packages (@agents-board/*).
          ['^@agents-board/'],
          // Nuxt virtual modules (#app, #imports, …).
          ['^#'],
          // App alias (~/...).
          ['^~'],
          // Relative imports.
          ['^\\.']
        ]
      }
    ]
  }
})
