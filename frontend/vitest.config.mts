import { defineConfig } from 'vitest/config';

// LibreGrid publishes ESM with extensionless relative imports. Node cannot load
// them directly, so Vitest transforms these packages instead of externalizing them.
export default defineConfig({
  test: {
    server: { deps: { inline: [/@libregrid\//] } },
  },
});
