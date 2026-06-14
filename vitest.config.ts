import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    singleFork: true,
    // Run tests serially
    fileParallelism: false,
  },
});
