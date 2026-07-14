import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One Postgres container is shared by the whole suite via globalSetup, which
    // migrates a template database. Test files run in parallel workers: each one
    // clones the template into a database of its own (`useTestDb`), and each test
    // creates its own project — so no special pool config is needed.
    globalSetup: ['./test/global-setup.ts'],
    // Disable the real embedding model in tests: writes skip it (fast suite) and
    // search falls back to lexical. Semantic paths are covered by mocking the
    // embedding module + seeding vectors directly (see embedding/search tests).
    env: { EMBEDDING_MODEL: 'none' },
    // Container startup + migrations can take a few seconds on a cold image.
    hookTimeout: 120_000,
    testTimeout: 30_000
  }
})
