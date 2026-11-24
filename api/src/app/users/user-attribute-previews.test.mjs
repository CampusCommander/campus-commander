import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import esbuild from 'esbuild';

/**
 * The value rules of B section 8, the C1 keys, and the preview digest, without a server or a
 * database. The route test boots the controller; this file holds the pure rules down.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { HttpException } = require('@nestjs/common');

const {
  checkedValue,
  checkedValues,
  currentEntries,
  editAttribute,
  editPreviewTargets,
  finalValue,
  isCalendarDate,
  parseTargetsCursor,
  previewDigest,
  selectionPreviewTargets,
  wireValue,
} = await import('./user-attribute-previews.ts');

const at = '2026-11-24T18:00:00.000Z';
const field = (overrides) => ({
  fieldId: 'fld-1',
  fieldName: 'Homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ADMINS_AND_SELF',
  numericIndexingSpec: null,
  holders: 3,
  ...overrides,
});
const homeroom = field({});
const programs = field({
  fieldId: 'fld-2',
  fieldName: 'Programs',
  displayName: 'Programs',
  multiValued: true,
});
const grade = field({
  fieldId: 'fld-3',
  fieldName: 'Grade',
  displayName: 'Grade',
  fieldType: 'INT64',
  indexed: true,
  numericIndexingSpec: { minValue: 0, maxValue: 12 },
});
const scores = field({
  fieldId: 'fld-4',
  fieldName: 'Scores',
  displayName: 'Scores',
  fieldType: 'DOUBLE',
  multiValued: true,
});
const base = {
  customerId: 'C0123456',
  generation: 1,
  categories: [
    {
      schemaId: 'schem=StudentInfo',
      schemaName: 'StudentInfo',
      displayName: 'Student info',
      etag: '"e1"',
      holders: 3,
      readAt: at,
      fields: [homeroom, programs, grade, scores],
    },
  ],
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 4,
    attributeLimit: 100,
  },
  observedAt: at,
};
const user = (userId, customSchemas, observedAt = at) => ({
  userId,
  primaryEmail: `${userId}@example.org`,
  customSchemas,
  observedAt,
});
const change = (fieldName, mode, values) => ({
  schemaName: 'StudentInfo',
  fieldName,
  mode,
  values,
});
const refusal = (run) => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
  throw new Error('expected a refusal');
};

test('a Set, a Clear, an Add, a Remove, and a Replace compute the final value', () => {
  const current = [
    { canonical: 'ELL', raw: { value: 'ELL', customType: 'x' } },
    { canonical: 'Band', raw: { value: 'Band' } },
  ];
  assert.deepEqual(finalValue('set', ['B12'], [], homeroom), {
    canonical: ['B12'],
    raw: 'B12',
  });
  assert.deepEqual(finalValue('clear', [], current, programs), {
    canonical: [],
    raw: null,
  });
  assert.deepEqual(
    finalValue('add', ['Band', 'Orchestra'], current, programs),
    {
      canonical: ['ELL', 'Band', 'Orchestra'],
      raw: [
        { value: 'ELL', customType: 'x' },
        { value: 'Band' },
        { value: 'Orchestra' },
      ],
    },
  );
  assert.deepEqual(finalValue('remove', ['ELL'], current, programs), {
    canonical: ['Band'],
    raw: [{ value: 'Band' }],
  });
  assert.deepEqual(finalValue('remove', ['ELL', 'Band'], current, programs), {
    canonical: [],
    raw: null,
  });
  assert.deepEqual(finalValue('replace', ['Orchestra'], current, programs), {
    canonical: ['Orchestra'],
    raw: [{ value: 'Orchestra' }],
  });
});

test('the value checks hold every info type of B section 8.1', () => {
  assert.equal(checkedValue('B12', homeroom), 'B12');
  assert.equal(checkedValue(7, grade), 7);
  assert.equal(checkedValue('7', grade), 7);
  assert.equal(checkedValue('2', grade), 2);
  assert.equal(checkedValue(1.5, scores), 1.5);
  assert.equal(checkedValue('1.5', scores), 1.5);
  assert.equal(checkedValue(true, field({ fieldType: 'BOOL' })), true);
  assert.equal(
    checkedValue('2024-02-29', field({ fieldType: 'DATE' })),
    '2024-02-29',
  );
  assert.equal(
    checkedValue('robin@example.org', field({ fieldType: 'EMAIL' })),
    'robin@example.org',
  );
});

test('an attribute value outside its info type answers 422 invalid-value', () => {
  const cases = [
    () => checkedValue(9007199254740992, grade),
    () => checkedValue('9007199254740992', grade),
    () => checkedValue('07', grade),
    () => checkedValue('7.5', grade),
    () => checkedValue('Infinity', scores),
    () => checkedValue('NaN', scores),
    () => checkedValue('true', field({ fieldType: 'BOOL' })),
    () => checkedValue('2026-02-30', field({ fieldType: 'DATE' })),
    () => checkedValue('2023-02-29', field({ fieldType: 'DATE' })),
    () => checkedValue('nope', field({ fieldType: 'EMAIL' })),
    () => checkedValue(7, homeroom),
  ];
  for (const run of cases) {
    const answer = refusal(run);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.reason, 'invalid-value');
  }
});

test('the range rule of E11 refuses a value outside the attribute range', () => {
  const answer = refusal(() => checkedValue(13, grade));
  assert.equal(answer.status, 422);
  assert.deepEqual(answer.body, {
    reason: 'invalid-value',
    message: 'Grade holds a value from 0 to 12.',
  });
  assert.equal(checkedValue(0, grade), 0);
  assert.equal(checkedValue(12, grade), 12);
  const open = refusal(() =>
    checkedValue(
      -1,
      field({
        fieldType: 'INT64',
        numericIndexingSpec: { minValue: 0, maxValue: null },
      }),
    ),
  );
  assert.deepEqual(open.body, {
    reason: 'invalid-value',
    message: 'Homeroom holds a value of at least 0.',
  });
});

test('a mode that the attribute shape does not fit answers 422 invalid-mode', () => {
  const multi = refusal(() =>
    selectionPreviewTargets(
      [user('u1', { StudentInfo: { Programs: [{ value: 'ELL' }] } })],
      [change('Programs', 'set', ['Band'])],
      base,
    ),
  );
  assert.equal(multi.status, 422);
  assert.equal(multi.body.reason, 'invalid-mode');
  const single = refusal(() =>
    selectionPreviewTargets(
      [user('u1', { StudentInfo: { Homeroom: 'B11' } })],
      [change('Homeroom', 'add', ['B12'])],
      base,
    ),
  );
  assert.equal(single.status, 422);
  assert.equal(single.body.reason, 'invalid-mode');
});

test('a repeated entered value answers 422 duplicate-value', () => {
  const answer = refusal(() => checkedValues(['ELL', 'ELL'], programs));
  assert.equal(answer.status, 422);
  assert.equal(answer.body.reason, 'duplicate-value');
  const numeric = refusal(() => checkedValues([5, '5'], grade));
  assert.equal(numeric.body.reason, 'duplicate-value');
  assert.deepEqual(checkedValues(['ELL', 'Band'], programs), ['ELL', 'Band']);
});

test('an unknown attribute answers 422 unknown-attribute', () => {
  const answer = refusal(() =>
    selectionPreviewTargets(
      [user('u1', {})],
      [change('Nope', 'set', ['B12'])],
      base,
    ),
  );
  assert.equal(answer.status, 422);
  assert.equal(answer.body.reason, 'unknown-attribute');
  const category = refusal(() =>
    selectionPreviewTargets(
      [user('u1', {})],
      [
        {
          schemaName: 'Nope',
          fieldName: 'Homeroom',
          mode: 'set',
          values: ['B12'],
        },
      ],
      base,
    ),
  );
  assert.equal(category.body.reason, 'unknown-attribute');
});

test('a selection preview gives Unchanged, Eligible, and one target per user', () => {
  const targets = selectionPreviewTargets(
    [
      user('u1', {
        StudentInfo: {
          Homeroom: 'B11',
          Programs: [{ value: 'ELL' }, { value: 'Band' }],
        },
      }),
      user('u2', {
        StudentInfo: { Homeroom: 'B12', Programs: [{ value: 'ELL' }] },
      }),
    ],
    [
      change('Homeroom', 'set', ['B12']),
      change('Programs', 'remove', ['Band']),
    ],
    base,
  );
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => [
      target.userId,
      target.ordinal,
      target.disposition,
    ]),
    [
      ['u1', 0, 'eligible'],
      ['u2', 1, 'unchanged'],
    ],
  );
  assert.deepEqual(
    targets[0].rows.map((row) => [
      row.fieldName,
      row.current,
      row.requested,
      row.disposition,
    ]),
    [
      ['Homeroom', 'B11', 'B12', 'eligible'],
      ['Programs', ['ELL', 'Band'], ['ELL'], 'eligible'],
    ],
  );
  assert.deepEqual(
    targets[1].rows.map((row) => row.disposition),
    ['unchanged', 'unchanged'],
  );
});

test('a Clear with no value is Unchanged, and a Remove of an absent value is Unchanged', () => {
  const targets = selectionPreviewTargets(
    [user('u1', { StudentInfo: { Programs: [{ value: 'ELL' }] } })],
    [change('Homeroom', 'clear', []), change('Programs', 'remove', ['Band'])],
    base,
  );
  assert.equal(targets[0].disposition, 'unchanged');
  assert.deepEqual(
    targets[0].rows.map((row) => row.disposition),
    ['unchanged', 'unchanged'],
  );
  assert.deepEqual(targets[0].rows[0].newValue, null);
  assert.deepEqual(targets[0].rows[1].requested, ['ELL']);
});

test('an edit list gives Conflict when the current value differs from the baseline', () => {
  const users = new Map([
    ['u1', user('u1', { StudentInfo: { Homeroom: 'B13' } })],
    ['u2', user('u2', { StudentInfo: { Homeroom: 'B12' } })],
    ['u3', user('u3', { StudentInfo: { Homeroom: 'B11' } })],
  ]);
  const edits = [
    {
      userId: 'u1',
      attribute: 'attr:StudentInfo.Homeroom',
      mode: 'set',
      values: ['B12'],
      baselineValue: 'B11',
    },
    {
      userId: 'u2',
      attribute: 'attr:StudentInfo.Homeroom',
      mode: 'set',
      values: ['B12'],
      baselineValue: 'B11',
    },
    {
      userId: 'u3',
      attribute: 'attr:StudentInfo.Homeroom',
      mode: 'set',
      values: ['B12'],
      baselineValue: 'B11',
    },
  ];
  const targets = editPreviewTargets(users, edits, base);
  assert.deepEqual(
    targets.map((target) => [target.userId, target.disposition]),
    [
      ['u1', 'conflict'],
      ['u2', 'unchanged'],
      ['u3', 'eligible'],
    ],
  );
});

test('one conflict row makes the target a Conflict, and one Eligible row wins over Unchanged', () => {
  const targets = editPreviewTargets(
    new Map([
      [
        'u1',
        user('u1', {
          StudentInfo: { Homeroom: 'B13', Programs: [{ value: 'ELL' }] },
        }),
      ],
      [
        'u2',
        user('u2', {
          StudentInfo: { Homeroom: 'B11', Programs: [{ value: 'ELL' }] },
        }),
      ],
    ]),
    [
      {
        userId: 'u1',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
      {
        userId: 'u1',
        attribute: 'attr:StudentInfo.Programs',
        mode: 'remove',
        values: ['ELL'],
        baselineValue: ['ELL'],
      },
      {
        userId: 'u2',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
      {
        userId: 'u2',
        attribute: 'attr:StudentInfo.Programs',
        mode: 'clear',
        values: [],
        baselineValue: ['ELL'],
      },
    ],
    base,
  );
  assert.deepEqual(
    targets.map((target) => [target.userId, target.disposition]),
    [
      ['u1', 'conflict'],
      ['u2', 'eligible'],
    ],
  );
});

test('the digest is stable and covers the source, the changes, and the rows', () => {
  const targets = selectionPreviewTargets(
    [user('u1', { StudentInfo: { Homeroom: 'B11' } })],
    [change('Homeroom', 'set', ['B12'])],
    base,
  );
  const changes = [change('Homeroom', 'set', ['B12'])];
  const first = previewDigest('selection', changes, targets);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(previewDigest('selection', changes, targets), first);
  assert.notEqual(
    previewDigest('selection', [change('Homeroom', 'set', ['B13'])], targets),
    first,
  );
  assert.notEqual(previewDigest('edit-list', [], targets), first);
  const moved = targets.map((target) => ({
    ...target,
    rows: target.rows.map((row) => ({ ...row, requested: 'B13' })),
  }));
  assert.notEqual(previewDigest('selection', changes, moved), first);
});

test('a wire value keeps its list shape and a missing value reads null', () => {
  assert.equal(wireValue(null), null);
  assert.equal(wireValue(undefined), null);
  assert.equal(wireValue('B12'), 'B12');
  assert.equal(wireValue(7), 7);
  assert.equal(wireValue(false), false);
  assert.deepEqual(
    wireValue([{ value: 'ELL' }, { value: 'Band', customType: 'x' }]),
    ['ELL', 'Band'],
  );
  assert.deepEqual(wireValue([{ value: 'ELL' }]), ['ELL']);
  assert.deepEqual(wireValue(['A', 'B']), ['A', 'B']);
});

test('a cursor of the form ordinal:schema.field parses, and a bad one answers 422', () => {
  assert.deepEqual(parseTargetsCursor('0:StudentInfo.Homeroom'), {
    ordinal: 0,
    schemaName: 'StudentInfo',
    fieldName: 'Homeroom',
  });
  assert.deepEqual(parseTargetsCursor('123:A-b.c_d'), {
    ordinal: 123,
    schemaName: 'A-b',
    fieldName: 'c_d',
  });
  for (const cursor of [
    '',
    'abc',
    '1:',
    ':a.b',
    '1:a',
    '-1:a.b',
    '1:a.b.c',
    '1:a b.c',
  ])
    assert.equal(refusal(() => parseTargetsCursor(cursor)).status, 422, cursor);
});

test('a date is a real calendar date and a C1 key splits into its two names', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  assert.equal(isCalendarDate('2023-02-29'), false);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-13-01'), false);
  assert.equal(isCalendarDate('2026-00-10'), false);
  assert.equal(isCalendarDate('2026-1-01'), false);
  assert.deepEqual(editAttribute('attr:StudentInfo.Homeroom'), {
    schemaName: 'StudentInfo',
    fieldName: 'Homeroom',
  });
});

test('the cached value list keeps each entry raw for a kept multi-value entry', () => {
  const entries = currentEntries(
    [{ value: 'ELL', customType: 'x' }, 'Band'],
    programs,
  );
  assert.deepEqual(
    entries.map((entry) => [entry.canonical, entry.raw]),
    [
      ['ELL', { value: 'ELL', customType: 'x' }],
      ['Band', 'Band'],
    ],
  );
  assert.deepEqual(currentEntries(null, programs), []);
});
