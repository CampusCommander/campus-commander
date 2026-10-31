/**
 * Guards the production tree against the Admin SDK mock (design section 4).
 * The mock is test infrastructure. Only a `*.test.mjs` file may name its package.
 * Run the file inside `nx run google-connection:test`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/** The package specifier of the mock. A production import would name it. */
const MOCK_PACKAGE = '@campuscommander/admin-sdk-mock';

/** The production source roots, and the source root of every library. */
const roots = [
  'api/src',
  'worker/src',
  'frontend/src',
  ...readdirSync('libs')
    .filter((name) => statSync(join('libs', name)).isDirectory())
    .map((name) => join('libs', name, 'src')),
];

test('no production source imports the Admin SDK mock', () => {
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:ts|mjs|cjs|js)$/.test(name)) continue;
      // A test file may import the mock, because the mock serves tests only.
      if (name.endsWith('.test.mjs')) continue;
      if (readFileSync(path, 'utf8').includes(MOCK_PACKAGE)) found.push(path);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(found, []);
});