import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 90000, // 90 seconds — nomic model is larger than MiniLM, first download takes time
    hookTimeout: 90000, // beforeEach hooks also need time for model loading + indexing
  },
});
