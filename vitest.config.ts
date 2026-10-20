import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Bound CPU/native SQLite contention so the 500-message integration run keeps its 5s budget.
    maxWorkers: 2,
    minWorkers: 1,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**', 'src/notify/**', 'src/server/views/**'],
    },
  },
});
