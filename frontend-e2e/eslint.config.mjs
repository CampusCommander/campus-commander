import playwright from 'eslint-plugin-playwright';
import baseConfig from '../eslint.config.mjs';

export default [
  playwright.configs['flat/recommended'],
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.js'],
    // Override or add rules here
    rules: {},
  },
  {
    // These files run under the Node test runner, not Playwright.
    files: ['test/**/*.mjs'],
    rules: {
      'playwright/expect-expect': 'off',
      'playwright/no-conditional-in-test': 'off',
    },
  },
];
