import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/real/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
