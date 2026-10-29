import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { POSTINO_DATA_DIR: '/tmp/postino-vitest' },
  },
});
