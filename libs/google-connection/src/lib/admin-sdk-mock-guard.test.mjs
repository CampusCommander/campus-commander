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
/** The double of the batch transport. A production import would name it. */
const BATCH_FAKE = 'batch-fake.mjs';
/** The names that only a test file, or the double itself, may hold. */
const DOUBLES = [MOCK_PACKAGE, BATCH_FAKE];

/** True when a file may name a double: a test file, or the double itself. */
const mayNameDouble = (name) =>
  name.endsWith('.test.mjs') || name === BATCH_FAKE;

/** The doubles that the text names. */
function doublesNamed(text) {
  return DOUBLES.filter((name) => text.includes(name));
}

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
      // A test file may import a double, because the doubles serve tests only.
      // The transport double itself matches the name it is known by.
      if (mayNameDouble(name)) continue;
      if (doublesNamed(readFileSync(path, 'utf8')).length) found.push(path);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(found, []);
});

test('the guard names the mock and the batch fake in a production source', () => {
  assert.deepEqual(
    doublesNamed("import { startMock } from '@campuscommander/admin-sdk-mock';"),
    [MOCK_PACKAGE],
  );
  assert.deepEqual(
    doublesNamed("import { fakeGoogle } from './batch-fake.mjs';"),
    [BATCH_FAKE],
  );
  assert.deepEqual(
    doublesNamed("import { GoogleDirectory } from './devices.ts';"),
    [],
  );
});
