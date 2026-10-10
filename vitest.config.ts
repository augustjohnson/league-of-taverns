import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{engine,bots,scripts,sims}/test/**/*.test.ts'],
    environment: 'node',
  },
});
