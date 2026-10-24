import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';

/**
 * The Playwright configuration of the review-runtime completion checks.
 *
 * The review command (`frontend-e2e/client-review-grid.mjs`) serves the built application
 * from `api-e2e:client-review-mock` at `BASE_URL`. No dev server starts here, and the
 * self-signed loopback certificate is accepted. The development configuration keeps its
 * own `webServer` for the normal Chromium suite.
 */
const baseURL = process.env['BASE_URL'] ?? 'https://127.0.0.1:37943';

export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true },
    },
  ],
});