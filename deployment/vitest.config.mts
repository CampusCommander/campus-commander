import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'deployment',
    watch: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
