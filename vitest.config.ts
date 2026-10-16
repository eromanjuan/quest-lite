import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The suite exercises the local database only — it must never reach out to
    // the real Firebase project (see server/db/firestore-sync.ts).
    env: { FIRESTORE_SYNC: '0' },
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
