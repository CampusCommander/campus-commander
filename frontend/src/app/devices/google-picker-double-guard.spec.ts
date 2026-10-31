import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PICKER_SCRIPT_URL } from './google-drive-picker';

/**
 * Guards the production tree against the Picker double
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, section "Production path
 * and test doubles", card DF2). The double lives under `frontend-e2e/` and answers the script URL
 * in a browser test. No production source imports it.
 */

/** The production source roots of the repository. */
const roots = [
  'api/src',
  'worker/src',
  'frontend/src',
  ...readdirSync(repoRoot('libs'))
    .filter((name: string) => statSync(repoRoot(join('libs', name))).isDirectory())
    .map((name: string) => join('libs', name, 'src')),
];

function repoRoot(relative: string): string {
  return join(fileURLToPath(new URL('../../../../', import.meta.url)), relative);
}

function walk(directory: string, visit: (path: string) => void): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      walk(path, visit);
      continue;
    }
    if (!/\.(?:ts|mjs|cjs|js)$/.test(name)) continue;
    if (/\.(?:spec|test)\.(?:ts|mjs|cjs|js)$/.test(name)) continue;
    visit(path);
  }
}

describe('the Picker double', () => {
  it('is imported by no production source', () => {
    const found: string[] = [];
    const pattern =
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*google-picker-double[^'"]*['"]/;
    for (const root of roots)
      walk(repoRoot(root), (path) => {
        if (pattern.test(readFileSync(path, 'utf8'))) found.push(path);
      });
    expect(found).toEqual([]);
  });

  it('keeps the real Picker script as the production source', () => {
    // The double answers this exact URL in a browser test only (design section 5).
    expect(PICKER_SCRIPT_URL).toBe('https://apis.google.com/js/api.js');
  });
});