# Device Grid Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the device grid on the server by organization unit, model, and battery class, with a device count on each group, and keep server-side selection working while the grid is grouped.

**Architecture:** The device query gains a grouping part: the grouped fields and the keys of the open group. A new endpoint returns one level of groups with their device counts. Leaf requests reuse the device query with the group keys as extra conditions. LibreGrid sends whole-group selection operations while the grid is grouped. The API stores each selected group as a group term with the filters that were active, and evaluates it in PostgreSQL like a Select All term.

**Tech Stack:** Angular 22, AG Grid Community 36.2.0, LibreGrid 1.3.5 (`row-grouping` added), NestJS, PostgreSQL, Redis, Zod 4, Vitest, `node:test`, and Playwright.

**Spec:** [docs/workflows/device-browsing.md](../../workflows/device-browsing.md), owner decision "Grid features": "Server-side grouping by OrgUnit, model, or battery class, with counts per group." Builds on [the grid features plan](2026-10-05-device-grid-features.md).

## Global Constraints

- Use exactly `ag-grid-community@36.2.0` and LibreGrid `1.3.5`. Add `@libregrid/row-grouping@1.3.5` as a direct dependency. Do not register pivot or aggregation features.
- Group fields are `orgUnitPath`, `model`, and `battery`. The grid nests at most three levels, each field once.
- Group keys match the filters exactly: the OrgUnit path, the model text (empty for no model), and the battery filter value (`normal`, `replace-soon`, `replace-now`, `no-report`, `unavailable`).
- LibreGrid loads each open group in one request. A request returns at most 1,000 groups or 1,000 devices. The status bar says so when a group holds more.
- While grouped, LibreGrid selects whole groups. Every selection rule from the grid features plan still holds.
- Call the API only through `AuthStore.request`. Use the existing `--cc-*` tokens. Repository prose follows the writing rules in `AGENTS.md`.
- Run tasks through Nx: `npm exec -- nx run <project>:<target> --skip-nx-cache`.

## Review Focus

1. **A group key that holds no devices any more.** A refresh removed the group's devices. The group simply disappears, and a stored group term selects nothing. Test: Task 2 SQL tests.
2. **A model or OrgUnit value that contains `|`.** LibreGrid joins group routes with `|` before it asks which groups are selected. The API matches the joined text against the real groups instead of splitting it, so such a group still resolves. Test: Task 2 group resolution SQL test.
3. **Filters change after a group is selected.** The group term keeps the filters it was selected under, as Select All does. Test: Task 2 state test.
4. **Deselecting a group inside a Select All term.** Only that group's devices become exceptions. The other devices stay selected. Test: Task 2 state test.
5. **Next device from a device inside a group.** Next device follows that group's order and stops at its last device. Test: Task 5 page test.

---

### Task 1: Group contracts and group SQL

**Files:**
- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`

**Interfaces:**
- Produces: in `@campus/application-contracts`:
  - `deviceGroupFieldSchema` and type `DeviceGroupField = 'orgUnitPath' | 'model' | 'battery'`.
  - `deviceGroupingSchema` and type `DeviceGrouping = { by: DeviceGroupField[]; keys: string[] }`. `by` holds at most three distinct fields. `keys` is never longer than `by`.
  - `deviceQuerySchema` gains `group: DeviceGrouping`, which defaults to `{ by: [], keys: [] }`. `limit` allows up to 1,000.
  - `deviceGroupQuerySchema`: a device query whose `group.keys` is shorter than `group.by`.
  - `deviceGroupPageSchema` and type `DeviceGroupPage = { groups: { key: string; devices: number }[]; groupCount: number; matching: number; total: number; observedAt: string | null }`. `matching` counts devices.
- Produces: in `api/src/app/devices/device-query.ts`, `deviceGroupsSql(customerId, query, selection = null): { groups: SqlStatement; count: SqlStatement }`, and `devicePageSql` narrowed by `query.group.keys`. The private helper `groupClauses(by, keys, add)` is reused by Task 2.

Group keys are the filter values. A group therefore converts to filters without loss.

- [ ] **Step 1: Write the failing contract tests**

In `libs/application-contracts/src/lib/devices.test.mjs`, add `deviceGroupQuerySchema` and `deviceGroupingSchema` to the import from `./devices.ts`. In `device queries default to the first serial page`, add `group: { by: [], keys: [] },` after `selection: null,` in the expected object. Append:

```js
test('grouping names each field once and keys only grouped levels', () => {
  const ok = (value) => deviceGroupingSchema.safeParse(value).success;
  assert.equal(ok({ by: ['orgUnitPath', 'battery'], keys: ['/School A'] }), true);
  assert.equal(ok({ by: ['model'], keys: [''] }), true);
  assert.equal(ok({ by: ['model', 'model'], keys: [] }), false);
  assert.equal(ok({ by: ['serialNumber'], keys: [] }), false);
  assert.equal(ok({ by: ['model'], keys: ['a', 'b'] }), false);
  assert.equal(
    ok({ by: ['orgUnitPath', 'model', 'battery', 'model'], keys: [] }),
    false,
  );
});

test('group requests need an unopened level', () => {
  const ok = (group) => deviceGroupQuerySchema.safeParse({ group }).success;
  assert.equal(ok({ by: ['battery'], keys: [] }), true);
  assert.equal(ok({ by: ['battery'], keys: ['normal'] }), false);
  assert.equal(ok({ by: [], keys: [] }), false);
  assert.equal(
    deviceQuerySchema.safeParse({ limit: 1000 }).success &&
      !deviceQuerySchema.safeParse({ limit: 1001 }).success,
    true,
  );
});
```

- [ ] **Step 2: Write the failing SQL tests**

In `api/src/app/devices/device-query.test.mjs`, add `deviceGroupQuerySchema` to the import from `@campus/application-contracts` and `deviceGroupsSql` to the import from `./device-query.ts`. Append:

```js
const batteryKey =
  "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' WHEN d.battery_status='reported' THEN d.battery_health ELSE d.battery_status END";

test('open groups narrow the device rows with exact keys', () => {
  const { rows, count } = query({
    group: { by: ['battery', 'model'], keys: ['replace-soon', ''] },
  });
  assert.ok(
    rows.text.includes(
      `WHERE s.customer_id=$1 AND ${batteryKey}=$2 AND coalesce(d.model,'')=$3 ORDER BY`,
    ),
  );
  assert.deepEqual(rows.values, ['C0123456', 'replace-soon', '', 0, 100]);
  assert.deepEqual(count.values, ['C0123456', 'replace-soon', '']);
});

test('a group level lists its keys with device counts', () => {
  const { groups, count } = deviceGroupsSql(
    'C0123456',
    deviceGroupQuerySchema.parse({
      predicates: [{ field: 'notes', operator: 'isEmpty' }],
      group: { by: ['orgUnitPath', 'model'], keys: ['/School A'] },
      limit: 1000,
    }),
  );
  assert.equal(
    groups.text,
    "SELECT coalesce(d.model,'') AS key,count(*)::integer AS devices FROM cc.device_sync_state s JOIN cc.devices d ON d.sync_id=s.current_sync_id WHERE s.customer_id=$1 AND (d.notes IS NULL OR d.notes='') AND d.org_unit_path=$2 GROUP BY 1 ORDER BY key ASC OFFSET $3 LIMIT $4",
  );
  assert.deepEqual(groups.values, ['C0123456', '/School A', 0, 1000]);
  assert.ok(
    count.text.startsWith(
      "SELECT count(DISTINCT coalesce(d.model,''))::integer AS groups,count(*)::integer AS matching FROM",
    ),
  );
  assert.deepEqual(count.values, ['C0123456', '/School A']);
});

test('battery groups follow the battery filter order', () => {
  const { groups } = deviceGroupsSql(
    'C0123456',
    deviceGroupQuerySchema.parse({ group: { by: ['battery'], keys: [] } }),
  );
  assert.ok(
    groups.text.includes(
      `GROUP BY 1 ORDER BY array_position(ARRAY['normal','replace-soon','replace-now','no-report','unavailable']::text[],${batteryKey}) OFFSET`,
    ),
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: FAIL. `deviceGroupingSchema` and `deviceGroupsSql` are not exported.

- [ ] **Step 4: Add the contracts**

In `libs/application-contracts/src/lib/devices.ts`, insert before the selection contracts (`const selectionIds = ...`):

```ts
export const deviceGroupFieldSchema = z.enum(['orgUnitPath', 'model', 'battery']);
export type DeviceGroupField = z.infer<typeof deviceGroupFieldSchema>;
/** Group keys are filter values: an OrgUnit path, a model (empty for none), or a battery filter value. */
const groupKey = z.string().max(4096);

/** The grouped fields, outermost first, and the keys of the open group. */
export const deviceGroupingSchema = z
  .strictObject({
    by: z.array(deviceGroupFieldSchema).max(3),
    keys: z.array(groupKey).max(3),
  })
  .refine((group) => new Set(group.by).size === group.by.length, {
    message: 'Group by each field once.',
  })
  .refine((group) => group.keys.length <= group.by.length, {
    message: 'Each group key needs a grouped field.',
  });
export type DeviceGrouping = z.infer<typeof deviceGroupingSchema>;
```

In `deviceQuerySchema`, change the `limit` member to `.max(1000)` and add after the `selection` member:

```ts
  /** Open group keys narrow the rows. LibreGrid loads an open group in one request. */
  group: deviceGroupingSchema.default({ by: [], keys: [] }),
```

After `devicePageSchema`, change its `rows` array to `.max(1000)`, and append:

```ts
/** A group request opens the next grouped level. */
export const deviceGroupQuerySchema = deviceQuerySchema.refine(
  (query) => query.group.keys.length < query.group.by.length,
  { message: 'A group request needs an unopened grouped level.' },
);

export const deviceGroupPageSchema = z.strictObject({
  groups: z
    .array(
      z.strictObject({ key: groupKey, devices: z.number().int().min(0) }),
    )
    .max(1000),
  groupCount: z.number().int().min(0),
  /** Devices in all groups of this level. */
  matching: z.number().int().min(0),
  total: z.number().int().min(0),
  observedAt: timestamp.nullable(),
});
export type DeviceGroupPage = z.infer<typeof deviceGroupPageSchema>;
```

`deviceGroupQuerySchema` must come after `deviceQuerySchema`. If `deviceGroupingSchema` is declared below the query schema in the file, move it above `deviceQuerySchema`.

- [ ] **Step 5: Add the group SQL**

In `api/src/app/devices/device-query.ts`, add `type DeviceGrouping` and `type DeviceGroupField` to the import from `@campus/application-contracts`. After `healthValues`, add:

```ts
/** Group keys equal the filter values, so a group converts to filters exactly. */
const groupKeys: Record<DeviceGroupField, string> = {
  orgUnitPath: 'd.org_unit_path',
  model: "coalesce(d.model,'')",
  battery:
    "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' WHEN d.battery_status='reported' THEN d.battery_health ELSE d.battery_status END",
};
const groupOrder: Record<DeviceGroupField, string> = {
  orgUnitPath: 'key ASC',
  model: 'key ASC',
  // PostgreSQL rejects an output alias inside an ORDER BY expression.
  battery: `array_position(ARRAY['normal','replace-soon','replace-now','no-report','unavailable']::text[],${groupKeys.battery})`,
};
```

After `predicateClauses`, add:

```ts
/** Devices inside an open group: each grouped level equals its key. */
function groupClauses(
  by: readonly DeviceGroupField[],
  keys: readonly string[],
  add: Add,
): string[] {
  return keys.map((key, level) => `${groupKeys[by[level]]}=${add(key)}`);
}
```

Change `deviceWhere` to take the open group after the selection, and put its clauses after the predicates:

```ts
function deviceWhere(
  predicates: readonly DevicePredicate[],
  values: unknown[],
  selection: SelectionState | null = null,
  group: DeviceGrouping | null = null,
): string {
  const add = adder(values);
  const clauses = [
    's.customer_id=$1',
    ...predicateClauses(predicates, add),
    ...(group ? groupClauses(group.by, group.keys, add) : []),
  ];
  if (selection) clauses.push(selectedClause(selection, add));
  return clauses.join(' AND ');
}
```

In `devicePageSql`, pass the group: `const where = deviceWhere(query.predicates, values, selection, query.group);`. Append:

```ts
/** One grouped level: each key with its device count, plus the number of keys and devices. */
export function deviceGroupsSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null = null,
): { groups: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  const field = query.group.by[query.group.keys.length];
  const key = groupKeys[field];
  return {
    groups: {
      text: `SELECT ${key} AS key,count(*)::integer AS devices ${from} WHERE ${where} GROUP BY 1 ORDER BY ${groupOrder[field]} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(DISTINCT ${key})::integer AS groups,count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: PASS.

Run: `npx tsc --noEmit -p api/tsconfig.app.json`
Expected: no output. Node strips types without checking them.

- [ ] **Step 7: Commit**

```bash
git add libs/application-contracts api/src/app/devices
git commit -m "feat: query device groups with counts"
```

---

### Task 2: Group selection contracts, state, and SQL

**Files:**
- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`
- Modify: `api/src/app/devices/device-selection.ts`
- Modify: `api/src/app/devices/device-selection.test.mjs`

**Interfaces:**
- Consumes: Task 1 `DeviceGroupField`, `groupKey`, and `groupClauses`.
- Produces: in `@campus/application-contracts`:
  - `deviceGroupScopeSchema` and type `DeviceGroupScope = { predicates: DevicePredicate[]; by: DeviceGroupField[]; route: string[] }`. `route` is not longer than `by`.
  - `deviceSelectionOpSchema` gains `{ op: 'selectGroup' } & DeviceGroupScope` and `{ op: 'deselectGroup' } & DeviceGroupScope`.
  - `deviceSelectionResolveSchema` gains `predicates` and `by`, both defaulting to `[]`.
  - `deviceSelectionSpecSchema` gains `groups: DeviceGroupScope[]`, defaulting to `[]`.
- Produces: in `device-query.ts`, `matchingAmongSql(customerId, predicates, ids, group = null)`, `selectedInSql(customerId, state, predicates, group)`, and `groupSelectionSql(customerId, state, predicates, by, routes)`. The last returns `route` and `selected` rows.
- Produces: in `device-selection.ts`, `SelectionState.groups: DeviceGroupScope[]`, and `applySelectionOps(state, ops, matching, selectedIn?)` where `matching(predicates, ids, group?)` and `selectedIn(state, predicates, group)` return device IDs.

A group term keeps the filters that were active, like a Select All term. Deselecting a group turns that group's selected devices into exceptions, so the rest of a Select All term stays selected.

- [ ] **Step 1: Write the failing contract test**

In `libs/application-contracts/src/lib/devices.test.mjs`, append:

```js
test('group selection operations carry the filters and grouped fields', () => {
  const ok = (op) =>
    deviceSelectionChangeSchema.safeParse({ gridId: 'devices', tabId, ops: [op] })
      .success;
  const scope = { predicates: [], by: ['orgUnitPath', 'model'], route: ['/School A'] };
  assert.equal(ok({ op: 'selectGroup', ...scope }), true);
  assert.equal(ok({ op: 'deselectGroup', ...scope, route: ['/School A', ''] }), true);
  assert.equal(ok({ op: 'selectGroup', ...scope, route: ['a', 'b', 'c'] }), false);
  assert.equal(ok({ op: 'selectGroup', ...scope, route: [] }), false);
});
```

- [ ] **Step 2: Write the failing SQL tests**

In `api/src/app/devices/device-query.test.mjs`, add `groupSelectionSql` and `selectedInSql` to the import from `./device-query.ts`. Append:

```js
test('a selected group holds its filtered devices inside the group', () => {
  const sql = selectionCountSql('C0123456', {
    terms: [],
    groups: [{ predicates: hs04Selection, by: ['battery'], route: ['replace-soon'] }],
    additions: [],
    exceptions: [],
  });
  assert.ok(
    sql.text.endsWith(
      `WHERE s.customer_id=$1 AND ((d.asset_tag ILIKE $2 AND ${batteryKey}=$3))`,
    ),
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', 'replace-soon']);
});

test('group lookups bind the group after the filters', () => {
  const matching = matchingAmongSql(
    'C0123456',
    [],
    ['d1'],
    { by: ['orgUnitPath'], keys: ['/School A'] },
  );
  assert.ok(
    matching.text.endsWith(
      'WHERE s.customer_id=$1 AND d.org_unit_path=$3 AND d.device_id=ANY($2::text[])',
    ),
  );
  const selected = selectedInSql(
    'C0123456',
    { terms: [[]], groups: [], additions: [], exceptions: ['d1'] },
    [],
    { by: ['orgUnitPath'], keys: ['/School A'] },
  );
  assert.ok(
    selected.text.endsWith(
      'WHERE s.customer_id=$1 AND d.org_unit_path=$2 AND ((TRUE) AND NOT d.device_id=ANY($3::text[]))',
    ),
  );
});

test('group selection matches the joined route text instead of splitting it', () => {
  const sql = groupSelectionSql(
    'C0123456',
    { terms: [], groups: [], additions: ['d9'], exceptions: [] },
    [],
    ['battery', 'model'],
    ['replace-soon|Lenovo | 100e'],
  );
  const route = `concat_ws('|',${batteryKey},coalesce(d.model,''))`;
  assert.equal(
    sql.text,
    `SELECT ${route} AS route,bool_and((d.device_id=ANY($3::text[]))) AS selected FROM cc.device_sync_state s JOIN cc.devices d ON d.sync_id=s.current_sync_id WHERE s.customer_id=$1 GROUP BY ${batteryKey},coalesce(d.model,'') HAVING ${route}=ANY($2::text[])`,
  );
  assert.deepEqual(sql.values, ['C0123456', ['replace-soon|Lenovo | 100e'], ['d9']]);
});
```

Also add near the top of the file, after `const query = ...`:

```js
const hs04Selection = [
  { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
];
```

`batteryKey` comes from Task 1. If Task 1 declared it after these tests, move its declaration to the top of the file.

- [ ] **Step 3: Write the failing state tests**

In `api/src/app/devices/device-selection.test.mjs`, add `groups: []` to each whole-state object that a test compares with `assert.deepEqual`: the two in `select and deselect move devices between additions and exceptions` and the one in `deselecting under a filter term records an exception`. In `the spec reports terms and counts without device IDs`, pass `groups: []` in the state and expect `groups: []` in the spec. Append:

```js
const replaceSoon = { predicates: hs04, by: ['battery'], route: ['replace-soon'] };

test('selecting a group clears the exceptions inside it and keeps its filters', async () => {
  const calls = [];
  const matching = async (predicates, ids, group) => {
    calls.push([predicates, ids, group]);
    return ['d1'];
  };
  const state = await applySelectionOps(
    { terms: [lenovo], groups: [], additions: [], exceptions: ['d1', 'd7'] },
    [
      { op: 'selectGroup', ...replaceSoon },
      { op: 'selectGroup', ...replaceSoon },
    ],
    matching,
  );
  assert.deepEqual(calls[0], [
    hs04,
    ['d1', 'd7'],
    { by: ['battery'], keys: ['replace-soon'] },
  ]);
  assert.deepEqual(state.groups, [replaceSoon]);
  assert.deepEqual(state.exceptions, ['d7']);
});

test('deselecting a group inside Select All excepts only that group', async () => {
  const asked = [];
  const selectedIn = async (state, predicates, group) => {
    asked.push([state.groups.length, predicates, group]);
    return ['d2', 'd3'];
  };
  const state = await applySelectionOps(
    { terms: [[]], groups: [replaceSoon], additions: ['d3', 'd8'], exceptions: [] },
    [{ op: 'deselectGroup', ...replaceSoon }],
    none,
    selectedIn,
  );
  // The exact group term goes first, then its remaining devices become exceptions.
  assert.deepEqual(asked, [[0, hs04, { by: ['battery'], keys: ['replace-soon'] }]]);
  assert.deepEqual(state, {
    terms: [[]],
    groups: [],
    additions: ['d8'],
    exceptions: ['d2', 'd3'],
  });
});

test('a deselected group without any term leaves no exceptions', async () => {
  const state = await applySelectionOps(
    { terms: [], groups: [replaceSoon], additions: [], exceptions: [] },
    [{ op: 'deselectGroup', ...replaceSoon }],
    none,
    async () => ['d2'],
  );
  assert.deepEqual(state, emptySelection());
});

test('the spec reports selected groups', () => {
  assert.deepEqual(
    selectionSpec(
      { terms: [], groups: [replaceSoon], additions: [], exceptions: [] },
      29,
    ).groups,
    [replaceSoon],
  );
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: FAIL. The schemas reject group operations, and `groupSelectionSql` is not exported.

- [ ] **Step 5: Add the group selection contracts**

In `libs/application-contracts/src/lib/devices.ts`, insert after `selectionKeyShape`:

```ts
const groupScopeShape = {
  predicates: z.array(devicePredicateSchema).max(20),
  by: z.array(deviceGroupFieldSchema).min(1).max(3),
  route: z.array(groupKey).min(1).max(3),
};
const routeFits = (scope: { by: string[]; route: string[] }) =>
  scope.route.length <= scope.by.length &&
  new Set(scope.by).size === scope.by.length;
const routeMessage = { message: 'A group route needs one grouped field per key.' };

/** A group as the grid showed it: the active filters, the grouped fields, and the group's keys. */
export const deviceGroupScopeSchema = z
  .strictObject(groupScopeShape)
  .refine(routeFits, routeMessage);
export type DeviceGroupScope = z.infer<typeof deviceGroupScopeSchema>;
```

Add these members to the `deviceSelectionOpSchema` union:

```ts
  z
    .strictObject({ op: z.literal('selectGroup'), ...groupScopeShape })
    .refine(routeFits, routeMessage),
  z
    .strictObject({ op: z.literal('deselectGroup'), ...groupScopeShape })
    .refine(routeFits, routeMessage),
```

If `z.discriminatedUnion` rejects refined members, use plain `strictObject` members and add one `.superRefine` on the union that applies `routeFits` to the two group operations. Ledger the ruling.

Add to `deviceSelectionResolveSchema`:

```ts
  /** The grid's filters and grouped fields, for the group rows in `groupRoutes`. */
  predicates: z.array(devicePredicateSchema).max(20).default([]),
  by: z.array(deviceGroupFieldSchema).max(3).default([]),
```

Add to `deviceSelectionSpecSchema`, after `terms`:

```ts
  groups: z.array(deviceGroupScopeSchema).max(50).default([]),
```

- [ ] **Step 6: Add the group selection SQL**

In `api/src/app/devices/device-query.ts`, change `selectedClause` to include the group terms:

```ts
/** Selected devices: any filter term, group term, or explicit addition, minus exceptions. */
function selectedClause(state: SelectionState, add: Add): string {
  const all = (clauses: string[]) =>
    clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
  const parts = [
    ...state.terms.map((term) => all(predicateClauses(term, add))),
    ...state.groups.map((group) =>
      all([
        ...predicateClauses(group.predicates, add),
        ...groupClauses(group.by, group.route, add),
      ]),
    ),
  ];
  if (state.additions.length)
    parts.push(`d.device_id=ANY(${add(state.additions)}::text[])`);
  if (!parts.length) return 'FALSE';
  const chosen = `(${parts.join(' OR ')})`;
  return state.exceptions.length
    ? `(${chosen} AND NOT d.device_id=ANY(${add(state.exceptions)}::text[]))`
    : chosen;
}
```

Replace `matchingAmongSql` with:

```ts
/** Which of the given devices match a filter, inside a group when one is given. */
export function matchingAmongSql(
  customerId: string,
  predicates: readonly DevicePredicate[],
  ids: readonly string[],
  group: DeviceGrouping | null = null,
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = deviceWhere(predicates, values, null, group);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.device_id=ANY($2::text[])`,
    values,
  };
}
```

Append:

```ts
/** The selected devices inside a filtered group. Deselecting the group excepts them. */
export function selectedInSql(
  customerId: string,
  selection: SelectionState,
  predicates: readonly DevicePredicate[],
  group: DeviceGrouping,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(predicates, values, selection, group);
  return { text: `SELECT d.device_id ${from} WHERE ${where}`, values };
}

/**
 * Whether each listed group is fully selected. LibreGrid joins routes with `|`,
 * so the statement compares the joined keys instead of splitting the text.
 */
export function groupSelectionSql(
  customerId: string,
  selection: SelectionState,
  predicates: readonly DevicePredicate[],
  by: readonly DeviceGroupField[],
  routes: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, routes];
  const where = deviceWhere(predicates, values);
  const selected = selectedClause(selection, adder(values));
  const keys = by.map((field) => groupKeys[field]).join(',');
  const route = `concat_ws('|',${keys})`;
  return {
    text: `SELECT ${route} AS route,bool_and(${selected}) AS selected ${from} WHERE ${where} GROUP BY ${keys} HAVING ${route}=ANY($2::text[])`,
    values,
  };
}
```

- [ ] **Step 7: Add group terms to the selection state**

In `api/src/app/devices/device-selection.ts`:

1. Add `deviceGroupScopeSchema`, `type DeviceGroupScope`, and `type DeviceGrouping` to the contracts import.
2. Add `groups` to `selectionStateSchema`:

```ts
  groups: z.array(deviceGroupScopeSchema).max(maxTerms).default([]),
```

3. `emptySelection()` returns `{ terms: [], groups: [], additions: [], exceptions: [] }`.
4. Replace `applySelectionOps` with:

```ts
const sameGroup = (a: DeviceGroupScope, b: DeviceGroupScope) =>
  JSON.stringify(a) === JSON.stringify(b);
const openGroup = (scope: DeviceGroupScope): DeviceGrouping => ({
  by: scope.by,
  keys: scope.route,
});

/**
 * Apply one batch of grid selection operations.
 * `matching` returns which of the given devices match a filter, inside a group when one is given.
 * `selectedIn` returns the selected devices inside a filtered group.
 */
export async function applySelectionOps(
  state: SelectionState,
  ops: readonly DeviceSelectionOp[],
  matching: (
    predicates: DevicePredicate[],
    ids: string[],
    group?: DeviceGrouping,
  ) => Promise<string[]>,
  selectedIn: (
    state: SelectionState,
    predicates: DevicePredicate[],
    group: DeviceGrouping,
  ) => Promise<string[]> = async () => [],
): Promise<SelectionState> {
  let { terms, groups = [], additions, exceptions } = state;
  const clearInScope = async (
    predicates: DevicePredicate[],
    group?: DeviceGrouping,
  ) => {
    if (!exceptions.length) return;
    const inScope = new Set(
      await (group
        ? matching(predicates, exceptions, group)
        : matching(predicates, exceptions)),
    );
    exceptions = exceptions.filter((id) => !inScope.has(id));
  };
  for (const op of ops) {
    if (op.op === 'deselectAll') {
      terms = [];
      groups = [];
      additions = [];
      exceptions = [];
    } else if (op.op === 'selectAll') {
      await clearInScope(op.predicates);
      if (!terms.some((term) => sameTerm(term, op.predicates)))
        terms = [...terms, op.predicates];
    } else if (op.op === 'selectGroup' || op.op === 'deselectGroup') {
      const scope: DeviceGroupScope = {
        predicates: op.predicates,
        by: op.by,
        route: op.route,
      };
      if (op.op === 'selectGroup') {
        await clearInScope(scope.predicates, openGroup(scope));
        if (!groups.some((group) => sameGroup(group, scope)))
          groups = [...groups, scope];
      } else {
        groups = groups.filter((group) => !sameGroup(group, scope));
        const ids = await selectedIn(
          { terms, groups, additions, exceptions },
          scope.predicates,
          openGroup(scope),
        );
        const chosen = new Set(ids);
        additions = additions.filter((id) => !chosen.has(id));
        if (terms.length || groups.length) exceptions = union(exceptions, ids);
      }
    } else if (op.op === 'select') {
      const ids = new Set(op.ids);
      exceptions = exceptions.filter((id) => !ids.has(id));
      additions = union(additions, op.ids);
    } else {
      const ids = new Set(op.ids);
      additions = additions.filter((id) => !ids.has(id));
      // Only a filter or group term can still hold a deselected device.
      if (terms.length || groups.length) exceptions = union(exceptions, op.ids);
    }
  }
  if (
    terms.length > maxTerms ||
    groups.length > maxTerms ||
    additions.length > maxIds ||
    exceptions.length > maxIds
  )
    throw new SelectionTooLargeError();
  return { terms, groups, additions, exceptions };
}
```

5. In `selectionSpec`, add `groups: state.groups,` after `terms`.

The `selectAll` path keeps calling `matching` with two arguments, so the existing Select All test still sees `[predicates, ids]`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: PASS.

Run: `npx tsc --noEmit -p api/tsconfig.app.json`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add libs/application-contracts api/src/app/devices
git commit -m "feat: evaluate selected device groups in the device query"
```

---

### Task 3: Group endpoints, group selection, and edge route

**Files:**
- Modify: `api/src/app/devices/devices.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Modify: `deployment/bootstrap/application-edge.mjs`
- Modify: `deployment/bootstrap/application-edge.test.mjs`
- Modify: `api-e2e/devices-api.mjs`

**Interfaces:**
- Consumes: Task 1 `deviceGroupQuerySchema`, `deviceGroupPageSchema`, and `deviceGroupsSql`; Task 2 lookups and `groupSelectionSql`.
- Produces: `POST /api/devices/groups` with a `deviceGroupQuerySchema` body. It requires `devices:read`, returns 200 and `{ groups: DeviceGroupPage }`, and honors `selection` like the device query.
- Produces: `POST /api/devices/selection/ops` accepts `selectGroup` and `deselectGroup`. `POST /api/devices/selection/resolve` answers group routes for the given `predicates` and `by`. A route that matches no group answers `false`.

- [ ] **Step 1: Write the failing edge test**

In `deployment/bootstrap/application-edge.test.mjs`, add to the allowed `routes` table after `['POST', '/api/devices/query', 'api'],`:

```js
      ['POST', '/api/devices/groups', 'api'],
```

Add to the denied table after `['GET', '/api/devices/selection/ops', 405],`:

```js
      ['GET', '/api/devices/groups', 405],
```

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: FAIL. `POST /api/devices/groups` returns 405, because the device read route matches it.

- [ ] **Step 2: Allow the route at the edge**

In `deployment/bootstrap/application-edge.mjs`, replace `deviceWrite` with:

```js
const deviceWrite =
  /^\/api\/devices\/(?:sync|query|groups|selection(?:\/(?:ops|resolve))?)$/;
```

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 3: Write the failing API check**

In `api-e2e/devices-api.mjs`, insert after the assertion that `deselectAll` returns a selected count of 0:

```js
    const groups = async (data) => {
      const response = await api.post(`${root}/groups`, { headers, data });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).groups;
    };
    const battery = await groups({ group: { by: ['battery'], keys: [] } });
    assert.equal(battery.matching, 450);
    assert.equal(battery.groupCount, battery.groups.length);
    assert.equal(
      battery.groups.reduce((sum, group) => sum + group.devices, 0),
      450,
    );
    assert.equal(
      battery.groups.find((group) => group.key === 'replace-soon')?.devices,
      135,
    );
    assert.equal(battery.groups[0].key, 'normal');
    const schoolA = await groups({
      group: { by: ['orgUnitPath', 'model'], keys: ['/School A'] },
    });
    assert.equal(schoolA.matching, 150);
    assert.equal(
      (
        await query({
          group: { by: ['battery'], keys: ['replace-soon'] },
          limit: 1000,
        })
      ).rows.length,
      135,
    );
    // While grouped, LibreGrid selects whole groups under the active filters.
    const grouped = { predicates: hs04, by: ['battery'], route: ['replace-soon'] };
    assert.equal(
      (await select('/ops', { ...tab, ops: [{ op: 'selectGroup', ...grouped }] }))
        .selection.selectedCount,
      29,
    );
    assert.deepEqual(
      (
        await select('/resolve', {
          ...tab,
          rowIds: [],
          groupRoutes: ['replace-soon', 'normal', 'no|such'],
          predicates: hs04,
          by: ['battery'],
        })
      ).selected,
      { 'replace-soon': true, normal: false, 'no|such': false },
    );
    assert.equal(
      (await select('/ops', { ...tab, ops: [{ op: 'deselectGroup', ...grouped }] }))
        .selection.selectedCount,
      0,
    );
```

Add this line to the returned list after the selection line:

```js
      'device groups count devices and select whole groups: pass',
```

- [ ] **Step 4: Add the service methods**

In `api/src/app/devices/devices.service.ts`:

1. Add `deviceGroupPageSchema`, `type DeviceGroupField`, `type DeviceGroupPage`, and `type DeviceGrouping` to the contracts import. Add `deviceGroupsSql`, `groupSelectionSql`, and `selectedInSql` to the `./device-query` import.
2. Add this method before `page`, and use it in `page` in place of the inline `device_sync_state` query and the `total` and `observedAt` expressions:

```ts
  /** The district total and observation time of the published inventory. */
  private async inventory(client: PoolClient, customerId: string) {
    const state = (
      await client.query(
        'SELECT device_count,observed_at FROM cc.device_sync_state WHERE customer_id=$1',
        [customerId],
      )
    ).rows[0];
    return {
      total: state?.['device_count'] ?? 0,
      observedAt:
        state?.['observed_at'] instanceof Date
          ? state['observed_at'].toISOString()
          : null,
    };
  }
```

3. After `page`, add:

```ts
  async groups(
    session: SessionResponse,
    query: DeviceQuery,
  ): Promise<DeviceGroupPage> {
    return this.read(
      session,
      async (client, customerId) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const sql = deviceGroupsSql(customerId, query, selection);
        const counts = (await client.query(sql.count.text, sql.count.values))
          .rows[0];
        const rows = (await client.query(sql.groups.text, sql.groups.values))
          .rows;
        return deviceGroupPageSchema.parse({
          groups: rows.map((row) => ({
            key: row['key'],
            devices: row['devices'],
          })),
          groupCount: counts?.['groups'] ?? 0,
          matching: counts?.['matching'] ?? 0,
          ...inventory,
        });
      },
      { groups: [], groupCount: 0, matching: 0, total: 0, observedAt: null },
    );
  }
```

4. In `changeSelection`, replace the `matching` constant and the `applySelectionOps` call with:

```ts
        const matching = (
          predicates: DevicePredicate[],
          ids: string[],
          group?: DeviceGrouping,
        ) =>
          this.deviceIds(
            client,
            matchingAmongSql(customerId, predicates, ids, group ?? null),
          );
        const selectedIn = (
          state: SelectionState,
          predicates: DevicePredicate[],
          group: DeviceGrouping,
        ) =>
          this.deviceIds(
            client,
            selectedInSql(customerId, state, predicates, group),
          );
```

   and pass both: `(current) => applySelectionOps(current, ops, matching, selectedIn)`.

5. Replace `resolveSelection` with:

```ts
  /** Rows resolve by device ID. Group rows resolve by their joined route under the grid's filters. */
  async resolveSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    rowIds: string[],
    groupRoutes: string[],
    predicates: DevicePredicate[],
    by: DeviceGroupField[],
  ): Promise<Record<string, boolean>> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = await this.storedSelection(session, key);
        const chosen = new Set(
          await this.deviceIds(
            client,
            selectedAmongSql(customerId, state, rowIds),
          ),
        );
        const selected: Record<string, boolean> = Object.fromEntries(
          rowIds.map((id) => [id, chosen.has(id)]),
        );
        for (const route of groupRoutes) selected[route] = false;
        if (groupRoutes.length)
          for (let depth = 1; depth <= by.length; depth++) {
            const sql = groupSelectionSql(
              customerId,
              state,
              predicates,
              by.slice(0, depth),
              groupRoutes,
            );
            for (const row of (await client.query(sql.text, sql.values)).rows)
              if (row['selected'] === true) selected[String(row['route'])] = true;
          }
        return selected;
      },
      {},
    );
  }
```

- [ ] **Step 5: Add the controller route and resolve inputs**

In `api/src/app/devices/devices.controller.ts`, add `deviceGroupQuerySchema` to the contracts import. Add after the `query` method:

```ts
  @Post('groups')
  @HttpCode(200)
  async groups(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceGroupQuerySchema.parse(body);
    await this.current(request);
    return { groups: await this.devices.groups(request.session, input) };
  }
```

In `resolveSelection`, pass the new inputs:

```ts
      selected: await this.devices.resolveSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.rowIds,
        input.groupRoutes,
        input.predicates,
        input.by,
      ),
```

- [ ] **Step 6: Run the checks**

Run: `npm exec -- nx run-many -t test lint build -p api --skip-nx-cache`
Expected: PASS.

Run: `npx tsc --noEmit -p api/tsconfig.app.json`
Expected: no output.

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache > .superpowers/sdd/2026-10-06-device-grid-grouping/task3-e2e.log 2>&1; tail -40 .superpowers/sdd/2026-10-06-device-grid-grouping/task3-e2e.log`
Expected: PASS, including the group line.

- [ ] **Step 7: Commit**

```bash
git add api/src/app deployment/bootstrap api-e2e/devices-api.mjs
git commit -m "feat: list device groups and select whole groups through the API"
```

---

### Task 4: Group data in the datasource, store, and selection provider

**Files:**
- Modify: `frontend/src/app/devices/device-fields.ts`
- Modify: `frontend/src/app/devices/device-fields.spec.ts`
- Modify: `frontend/src/app/devices/device-datasource.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`
- Modify: `frontend/src/app/devices/devices.store.ts`
- Modify: `frontend/src/app/devices/devices.store.spec.ts`
- Modify: `frontend/src/app/devices/device-selection.ts`
- Modify: `frontend/src/app/devices/device-selection.spec.ts`
- Modify: `frontend/src/app/devices/device-status-panel.spec.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 contracts.
- Produces: in `device-fields.ts`, `groupLabel(field: DeviceGroupField, key: string): string`.
- Produces: in `device-datasource.ts`:
  - `GROUP_LIMIT = 1000`.
  - `DeviceView.group?: DeviceGrouping`.
  - `type DeviceGroupLoader = (view: DeviceView) => Promise<DeviceGroupPage | null>`.
  - `deviceDatasource(load, onLoaded?, selection?, loadGroups?)`. A grouped level calls `loadGroups`. An open group loads up to `GROUP_LIMIT` devices with `load`.
- Produces: in `DevicesStore`, `groups(view): Promise<DeviceGroupPage | null>` and `groupLimit: WritableSignal<boolean>`. Only an outermost query (no open group keys) updates `page`.
- Produces: `DeviceSelectionProvider(call, context?)`, where `context(): { predicates: DevicePredicate[]; by: DeviceGroupField[] }` describes the grid. Group operations and group routes carry that context.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/app/devices/device-fields.spec.ts`, add `groupLabel` to the import and append:

```ts
it('labels group keys the way the filters read', () => {
  expect(groupLabel('orgUnitPath', '/School A/Library')).toBe(
    '/School A/Library',
  );
  expect(groupLabel('model', '')).toBe('No model');
  expect(groupLabel('model', 'Lenovo 100e')).toBe('Lenovo 100e');
  expect(groupLabel('battery', 'replace-soon')).toBe('Replace soon');
});
```

In `frontend/src/app/devices/device-grid.spec.ts`, append:

```ts
const groupPage = {
  groups: [
    { key: 'normal', devices: 300 },
    { key: 'replace-soon', devices: 135 },
  ],
  groupCount: 2,
  matching: 435,
  total: 450,
  observedAt: null,
};

it('loads one grouped level with its device counts', async () => {
  const load = vi.fn();
  const loadGroups = vi.fn().mockResolvedValue(groupPage);
  const success = vi.fn();
  deviceDatasource(load, undefined, undefined, loadGroups).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'battery', displayName: 'Battery' }],
      groupKeys: [],
    },
    api: { getGridOption: () => false },
    success,
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(loadGroups).toHaveBeenCalledWith({
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['battery'], keys: [] },
  });
  expect(success).toHaveBeenCalledWith({
    rowData: groupPage.groups,
    rowCount: 2,
  });
  expect(load).not.toHaveBeenCalled();
});

it('loads an open group in one request up to the group limit', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [row],
    matching: 135,
    total: 450,
    observedAt: null,
  });
  deviceDatasource(load, undefined, undefined, vi.fn()).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'battery', displayName: 'Battery' }],
      groupKeys: ['replace-soon'],
    },
    api: { getGridOption: () => false },
    success: vi.fn(),
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0].slice(0, 2)).toEqual([0, GROUP_LIMIT]);
  expect(load.mock.calls[0][2].group).toEqual({
    by: ['battery'],
    keys: ['replace-soon'],
  });
});

it('fails a grouped level that the device query cannot group', () => {
  const fail = vi.fn();
  deviceDatasource(vi.fn(), undefined, undefined, vi.fn()).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'serialNumber', displayName: 'Serial' }],
      groupKeys: [],
    },
    api: { getGridOption: () => false },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  expect(fail).toHaveBeenCalled();
});
```

Add `GROUP_LIMIT` to the import from `./device-datasource`.

In `frontend/src/app/devices/devices.store.spec.ts`, append:

```ts
const groupBody = {
  groups: [{ key: '/School A', devices: 150 }],
  groupCount: 2,
  matching: 450,
  total: 450,
  observedAt: page.observedAt,
};

it('only the outermost grouped query reports counts and the group limit', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ groups: groupBody }))
    .mockResolvedValueOnce(
      Response.json({ page: { ...page, matching: 150, rows: [] } }),
    );
  const store = setup(request);
  const root = {
    predicates: [],
    sort: { field: 'serialNumber' as const, direction: 'asc' as const },
    selection: null,
    group: { by: ['orgUnitPath' as const], keys: [] },
  };
  store.setView(root);
  await store.groups(root);
  expect(request).toHaveBeenCalledWith('/api/devices/groups', {
    ...root,
    offset: 0,
    limit: 1000,
  });
  expect(store.page()?.matching).toBe(450);
  expect(store.groupLimit()).toBe(true);
  store.setView({ ...root, group: { by: ['orgUnitPath'], keys: ['/School A'] } });
  await store.rows(0, 1000);
  expect(store.page()?.matching).toBe(450);
});

it('describes the grid to the selection provider', async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({ selected: { '/School A': true } }),
  );
  const store = setup(request);
  store.setView({
    predicates: [{ field: 'notes', operator: 'isEmpty' }],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['orgUnitPath'], keys: [] },
  });
  await store.selection.resolveSelected({
    gridId: 'devices',
    tabId: store.selectionTab,
    rowIds: [],
    groupRoutes: ['/School A'],
  });
  expect(request).toHaveBeenCalledWith('/api/devices/selection/resolve', {
    gridId: 'devices',
    tabId: store.selectionTab,
    rowIds: [],
    groupRoutes: ['/School A'],
    predicates: [{ field: 'notes', operator: 'isEmpty' }],
    by: ['orgUnitPath'],
  });
});
```

In `frontend/src/app/devices/device-selection.spec.ts`, add `groups: [],` to the `spec` constant after `terms`, and to the object passed to `selectionScope` in `describes what Select All captured`. Append:

```ts
const context = () => ({
  predicates: spec.terms[0].predicates,
  by: ['battery' as const],
});

it('sends group selections with the grid filters and grouped fields', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call, context);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [{ op: 'selectGroup', route: ['replace-soon'] }],
  });
  expect(call.mock.calls[0][1].ops).toEqual([
    {
      op: 'selectGroup',
      predicates: spec.terms[0].predicates,
      by: ['battery'],
      route: ['replace-soon'],
    },
  ]);
});

it('resolves group rows even when no device rows are loaded', async () => {
  const call = vi
    .fn()
    .mockResolvedValue(Response.json({ selected: { 'replace-soon': true } }));
  const provider = new DeviceSelectionProvider(call, context);
  expect(
    await provider.resolveSelected({
      gridId: 'devices',
      tabId,
      rowIds: [],
      groupRoutes: ['replace-soon'],
    }),
  ).toEqual({ 'replace-soon': true });
  expect(call.mock.calls[0][1].by).toEqual(['battery']);
});

it('reports selected groups to LibreGrid and the status bar', async () => {
  const grouped: DeviceSelectionSpec = {
    terms: [],
    groups: [
      {
        predicates: [],
        by: ['orgUnitPath', 'battery'],
        route: ['/School A', 'replace-soon'],
      },
    ],
    added: 0,
    excluded: 0,
    selectedCount: 12,
  };
  const provider = new DeviceSelectionProvider(
    vi.fn().mockResolvedValue(Response.json({ selection: grouped })),
  );
  expect((await provider.getSpec({ gridId: 'devices', tabId })).terms).toEqual([
    { type: 'group', route: ['/School A', 'replace-soon'] },
  ]);
  expect(selectionScope(grouped)).toBe(
    'Selected groups: /School A › Replace soon',
  );
});
```

In `frontend/src/app/devices/device-status-panel.spec.ts`, add `groups: [],` to the spec passed to `store.selection.spec.set`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `groupLabel`, `GROUP_LIMIT`, and `store.groups` do not exist.

- [ ] **Step 3: Add the group label**

In `frontend/src/app/devices/device-fields.ts`, add `type DeviceGroupField` to the contracts import and append:

```ts
/** A group key as the filters read it. */
export function groupLabel(field: DeviceGroupField, key: string): string {
  if (field === 'model') return key || 'No model';
  if (field === 'battery')
    return BATTERY_LABELS[key as BatteryFilterValue] ?? key;
  return key;
}
```

- [ ] **Step 4: Load groups in the datasource**

In `frontend/src/app/devices/device-datasource.ts`:

1. Add `deviceGroupFieldSchema`, `type DeviceGroupField`, `type DeviceGroupPage`, and `type DeviceGrouping` to the contracts import. `deviceGroupFieldSchema` is a value import.
2. Add after `DeviceLoader`:

```ts
/** LibreGrid loads an open group in one request, so each request lists at most this many groups or devices. */
export const GROUP_LIMIT = 1000;
export type DeviceGroupLoader = (
  view: DeviceView,
) => Promise<DeviceGroupPage | null>;
```

3. Add `group?: DeviceGrouping;` to `DeviceView`, with the comment `/** Grouped fields and the keys of the open group. Absent while the grid is flat. */`.
4. Change the `deviceDatasource` signature to add `loadGroups?: DeviceGroupLoader` as the fourth parameter, and replace the body of `getRows` with:

```ts
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      let predicates: DevicePredicate[];
      let by: DeviceGroupField[];
      try {
        predicates = predicatesFromFilterModel(
          params.request.filterModel as FilterModel | null,
        );
        by = (params.request.rowGroupCols ?? []).map((column) =>
          deviceGroupFieldSchema.parse(column.id),
        );
      } catch {
        params.fail();
        return;
      }
      const keys = params.request.groupKeys ?? [];
      const view: DeviceView = {
        predicates,
        sort: sortFromModel(params.request.sortModel),
        // Show All Selected limits the query to this tab's selection.
        selection:
          selection && params.api.getGridOption('ssrmSelectionViewActive')
            ? selection
            : null,
        ...(by.length ? { group: { by, keys } } : {}),
      };
      if (by.length && keys.length < by.length) {
        if (!loadGroups) return params.fail();
        loadGroups(view).then(
          (page) => {
            if (!page) return params.fail();
            // LibreGrid reads each group row's key and keeps the record for the group column.
            params.success({
              rowData: page.groups as unknown as DeviceRow[],
              rowCount: page.groupCount,
            });
          },
          () => params.fail(),
        );
        return;
      }
      const offset = params.request.startRow ?? 0;
      const limit = by.length
        ? GROUP_LIMIT
        : Math.min(
            200,
            Math.max(1, (params.request.endRow ?? offset + 100) - offset),
          );
      load(offset, limit, view).then(
        (page) => {
          if (!page) return params.fail();
          params.success({ rowData: page.rows, rowCount: page.matching });
          onLoaded?.(page);
        },
        () => params.fail(),
      );
    },
```

- [ ] **Step 5: Count only the outermost query in the store**

In `frontend/src/app/devices/devices.store.ts`:

1. Add `deviceGroupPageSchema` and `type DeviceGroupPage` to the contracts import, and `GROUP_LIMIT` to the `./device-datasource` import (it becomes a value import).
2. Add before the class:

```ts
/** Only the outermost query reports counts. Open groups and Next device leave them alone. */
const countsKey = (view: DeviceView): string | null =>
  view.group?.keys.length
    ? null
    : JSON.stringify([view.predicates, view.selection, view.group?.by ?? []]);
```

3. Replace the `selection` field with:

```ts
  readonly selection = new DeviceSelectionProvider(
    (path, body) => this.call(path, body),
    () => ({
      predicates: this.view().predicates,
      by: this.view().group?.by ?? [],
    }),
  );
```

4. Add fields after `page`:

```ts
  /** True when an open group or a grouped level holds more than the grid lists. */
  readonly groupLimit = signal(false);
  /** The outermost query whose counts the status bar shows. */
  private counted = countsKey(defaultView());
```

5. In `reset()`, add `this.groupLimit.set(false);` and `this.counted = countsKey(defaultView());`.
6. Replace `rows` with these methods:

```ts
  async rows(offset: number, limit: number): Promise<DevicePage | null> {
    const view = this.view();
    const revision = this.revision();
    const response = await this.call('/api/devices/query', {
      ...view,
      offset,
      limit,
    });
    if (!response?.ok) return null;
    const page = devicePageSchema.parse((await response.json()).page);
    if (view.group?.by.length && page.rows.length < page.matching)
      this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  async groups(view: DeviceView): Promise<DeviceGroupPage | null> {
    const revision = this.revision();
    const response = await this.call('/api/devices/groups', {
      ...view,
      offset: 0,
      limit: GROUP_LIMIT,
    });
    if (!response?.ok) return null;
    const page = deviceGroupPageSchema.parse((await response.json()).groups);
    if (page.groups.length < page.groupCount) this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  /** A response for a query that changed meanwhile must not replace the counts. */
  private keepCounts(
    view: DeviceView,
    revision: number,
    counts: Omit<DevicePage, 'rows'>,
  ): void {
    const key = countsKey(view);
    if (key === null || key !== this.counted || revision !== this.revision())
      return;
    this.page.set({
      matching: counts.matching,
      total: counts.total,
      observedAt: counts.observedAt,
    });
  }
```

7. Replace `setView` with:

```ts
  /** The grid reports each query it runs. A different query forgets the opened row. */
  setView(view: DeviceView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view())) return;
    this.view.set(view);
    this.position.set(null);
    const key = countsKey(view);
    if (key === null || key === this.counted) return;
    this.counted = key;
    this.groupLimit.set(false);
  }
```

`keepCounts` passes only the three count fields, so a group page works as well as a device page.

- [ ] **Step 6: Send group selections with the grid context**

In `frontend/src/app/devices/device-selection.ts`:

1. Add `type DeviceGroupField` and `type DevicePredicate` to the contracts import, and `groupLabel` to the `./device-fields` import.
2. Add before `deviceOps`:

```ts
/** The grid's filters and grouped fields. Group operations and group routes need both. */
export interface SelectionContext {
  predicates: DevicePredicate[];
  by: DeviceGroupField[];
}
const flat = (): SelectionContext => ({ predicates: [], by: [] });
```

3. Change `deviceOps` to take the context and handle group operations. Replace its `default` branch with:

```ts
    case 'selectGroup':
    case 'deselectGroup':
      return [{ op: op.op, ...context, route: op.route }];
```

   and its signature with `function deviceOps(op: SelectionOp, context: SelectionContext): DeviceSelectionOp[]`.

4. Give the provider a second constructor parameter:

```ts
  constructor(
    private readonly call: (
      path: string,
      body: unknown,
    ) => Promise<Response | null>,
    private readonly context: () => SelectionContext = flat,
  ) {}
```

5. In `applyOps`, map with the context: `const context = this.context(); const ops = params.ops.flatMap((op) => deviceOps(op, context));`.
6. In `getSpec`, report group terms after the filter terms:

```ts
      terms: [
        ...spec.terms.map((term) => ({
          type: 'all' as const,
          filter: filterModelFromPredicates(term.predicates),
        })),
        ...spec.groups.map((group) => ({
          type: 'group' as const,
          route: group.route,
        })),
      ],
```

7. Replace `resolveSelected` with:

```ts
  async resolveSelected(params: {
    gridId: string;
    tabId: string;
    rowIds: string[];
    groupRoutes: string[];
  }): Promise<Record<string, boolean>> {
    const context = this.context();
    const selected: Record<string, boolean> = {};
    // The first request also carries the group routes, so groups resolve without device rows.
    const batches = Math.max(1, Math.ceil(params.rowIds.length / idBatch));
    for (let batch = 0; batch < batches; batch++) {
      const body = await this.post('/resolve', {
        ...key(params),
        rowIds: params.rowIds.slice(batch * idBatch, (batch + 1) * idBatch),
        groupRoutes: batch === 0 ? params.groupRoutes : [],
        ...context,
      });
      Object.assign(
        selected,
        z
          .record(z.string(), z.boolean())
          .parse((body as { selected?: unknown }).selected),
      );
    }
    return selected;
  }
```

8. Replace `selectionScope` with:

```ts
/** What Select All and group selection captured, with explicit changes (SELECT-01). */
export function selectionScope(spec: DeviceSelectionSpec | null): string {
  if (!spec || (!spec.terms.length && !spec.groups.length)) return '';
  const terms = spec.terms
    .map((term) =>
      term.predicates.length
        ? term.predicates.map(chipLabel).join(' and ')
        : 'All devices',
    )
    .join('; ');
  const groups = spec.groups
    .map((group) =>
      group.route
        .map((routeKey, level) => groupLabel(group.by[level], routeKey))
        .join(' › '),
    )
    .join('; ');
  return [
    ...(terms ? [`Selected by filter: ${terms}`] : []),
    ...(groups ? [`Selected groups: ${groups}`] : []),
    ...(spec.added ? [`${spec.added} added`] : []),
    ...(spec.excluded ? [`${spec.excluded} excluded`] : []),
  ].join(' · ');
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run frontend:lint --skip-nx-cache`
Expected: PASS with no new warnings.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: load device groups and select them from the grid"
```

---

### Task 5: Group the device grid

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `frontend/src/app/devices/device-columns.ts`
- Modify: `frontend/src/app/devices/device-details-cell.ts`
- Modify: `frontend/src/app/devices/device-grid-options.ts`
- Modify: `frontend/src/app/devices/device-grid-options.spec.ts`
- Modify: `frontend/src/app/devices/device-grid.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`
- Modify: `frontend/src/app/devices/device-status-panel.ts`
- Modify: `frontend/src/app/devices/device-status-panel.spec.ts`
- Modify: `frontend/src/app/devices/devices.ts`
- Modify: `frontend/src/app/devices/devices.html`
- Modify: `frontend/src/app/devices/devices.spec.ts`

**Interfaces:**
- Consumes: Task 4 `DeviceGroupLoader`, `store.groups`, `store.groupLimit`, and `groupLabel`.
- Produces: in `device-columns.ts`, `deviceGroupColumn: AutoGroupColumnDef<DeviceRow>`, and `onDetails(row, node)` callbacks that receive the row node.
- Produces: in `device-grid-options.ts`, `detailsTarget(node): { index: number; route: string[] | null } | null`. A device inside a group reports its index in that group and the group's route.
- Produces: `DeviceGrid` input `loadGroups: DeviceGroupLoader` and output `details: { row: DeviceRow; index: number; route: string[] | null }`.

The column menu and the Columns side bar group by OrgUnit, model, and battery class. Group rows show the label and the device count. Next device from a grouped device follows its group.

- [ ] **Step 1: Install the row grouping package**

Run: `npm install --save-exact @libregrid/row-grouping@1.3.5`
Expected: `package.json` lists `"@libregrid/row-grouping": "1.3.5"`. `npm ls ag-grid-community` shows only `36.2.0`.

- [ ] **Step 2: Write the failing tests**

In `frontend/src/app/devices/device-grid.spec.ts`:

1. Add `deviceGroupColumn` to the `./device-columns` import, and import `detailsTarget` from `./device-grid-options`.
2. Replace the test `opens details with Enter and leaves Space to row selection` with:

```ts
it('opens details with Enter and leaves Space to row selection', () => {
  const onDetails = vi.fn();
  const handler = detailsKeyHandler(onDetails);
  const node = { rowIndex: 3, group: false };
  const press = (colId: string, key: string, target = node) =>
    handler({
      column: { getColId: () => colId },
      data: row,
      node: target,
      event: new KeyboardEvent('keydown', { key }),
    } as unknown as CellKeyDownEvent<DeviceRow>);
  press('details', 'Enter');
  press('details', ' ');
  press('serialNumber', 'Enter');
  press('details', 'Enter', { rowIndex: 0, group: true });
  expect(onDetails.mock.calls).toEqual([[row, node]]);
});
```

3. Append:

```ts
it('groups by organization unit, model, and battery with counts', () => {
  const columns = deviceColumnDefs(() => undefined);
  expect(
    columns.filter((column) => column.enableRowGroup).map((column) => column.colId),
  ).toEqual(['model', 'orgUnitPath', 'battery']);
  const battery = columns.find((column) => column.colId === 'battery')!;
  const groupNode = { group: true, field: 'battery' };
  const groupRow = { key: 'replace-soon', devices: 1350 };
  expect(
    (battery.valueGetter as Getter)({
      data: groupRow,
      node: groupNode,
    } as never),
  ).toBe('');
  expect(
    (deviceGroupColumn.valueGetter as Getter)({
      data: groupRow,
      node: groupNode,
    } as never),
  ).toBe('Replace soon (1,350)');
});

it('finds a grouped device by its index inside the group', () => {
  const parent = { group: true, __lgrSsrmRoute: ['replace-soon'] };
  expect(
    detailsTarget({ rowIndex: 40, sourceRowIndex: 7, parent } as never),
  ).toEqual({ index: 7, route: ['replace-soon'] });
  expect(
    detailsTarget({ rowIndex: 40, sourceRowIndex: 40, parent: null } as never),
  ).toEqual({ index: 40, route: null });
  expect(detailsTarget({ rowIndex: null, parent: null } as never)).toBeNull();
});
```

In `frontend/src/app/devices/device-grid-options.spec.ts`, in the first test, remove `suppressRowGroups: true,` from the expected `toolPanelParams`, and add after the side bar assertion:

```ts
  expect(
    options.getColumnMenuItems?.({ defaultItems: ['sortAscending'] } as never),
  ).toEqual(['sortAscending', 'separator', 'rowGroup', 'rowUnGroup']);
  expect(options.autoGroupColumnDef?.headerName).toBe('Group');
```

In `frontend/src/app/devices/device-status-panel.spec.ts`, add `groupLimit: signal(false),` to the fake store, and append:

```ts
it('says when an open group lists only its first devices', () => {
  const { store, element, render } = setup(null);
  store.groupLimit.set(true);
  render();
  expect(element.textContent).toContain(
    'Open groups list their first 1,000 devices. Add a filter to see the rest.',
  );
});
```

In `frontend/src/app/devices/devices.spec.ts`:

1. Add `readonly loadGroups = input<unknown>();` to `GridStub`, and change its `details` output to `output<{ row: DeviceRow; index: number; route: string[] | null }>()`. Import `type DeviceRow` from the contracts.
2. Add `Router` to the `@angular/router` import.
3. Append:

```ts
it('follows the opened device's group for Next device', () => {
  const { store, fixture } = setup({
    sync: ready(),
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  store.view.set({
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['battery'], keys: [] },
  } as never);
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  grid.details.emit({
    row: { deviceId: 'd7' } as DeviceRow,
    index: 4,
    route: ['replace-soon'],
  });
  expect(store.view()).toMatchObject({
    group: { by: ['battery'], keys: ['replace-soon'] },
  });
  expect(store.position()).toEqual({ index: 4, deviceId: 'd7' });
  expect(navigate).toHaveBeenCalledWith(['/devices', 'd7']);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `deviceGroupColumn` and `detailsTarget` are not exported, and the page ignores the route.

- [ ] **Step 4: Make the columns groupable**

In `frontend/src/app/devices/device-columns.ts`:

1. Add `AutoGroupColumnDef` and `IRowNode` to the `ag-grid-community` type import. Add `groupLabel` to the `./device-fields` import, and `type DeviceGroupField` to the contracts import.
2. Add before `columnFilter`:

```ts
const groupable = new Set<string>(['orgUnitPath', 'model', 'battery']);

/** Group rows carry the key and device count from the group request. */
interface DeviceGroupRow {
  key: string;
  devices: number;
}

/** The group column shows each group's label and device count. */
export const deviceGroupColumn: AutoGroupColumnDef<DeviceRow> = {
  headerName: 'Group',
  minWidth: 260,
  // Pinned with the checkbox, so a group row's label and checkbox share one row element.
  pinned: 'left',
  sortable: false,
  filter: false,
  valueGetter: ({ node, data }) => {
    if (!node?.group || !data || !node.field) return '';
    const group = data as unknown as DeviceGroupRow;
    return `${groupLabel(node.field as DeviceGroupField, group.key)} (${group.devices.toLocaleString('en-US')})`;
  },
  // The label carries the server count. Loaded children would undercount.
  cellRendererParams: { suppressCount: true },
};
```

3. Change the `onDetails` parameter type of `deviceColumnDefs` and `detailsKeyHandler` to `(row: DeviceRow, node: IRowNode<DeviceRow>) => void`.
4. In each data column, replace the `valueGetter` with:

```ts
        valueGetter: ({ data, node }) =>
          data && !node?.group ? value(data, field.id, now()) : '',
        enableRowGroup: groupable.has(field.id),
```

5. In `detailsKeyHandler`, replace the last three lines of the handler with:

```ts
    if (!event.data || event.node.group) return;
    keyboard.preventDefault();
    onDetails(event.data, event.node);
```

In `frontend/src/app/devices/device-details-cell.ts`, change `onDetails(row: DeviceRow, index: number): void;` to `onDetails(row: DeviceRow, node: IRowNode<DeviceRow>): void;` and import `type IRowNode` from `ag-grid-community`. Add a computed `group = computed(() => !!this.params()?.node.group);`, wrap the button in `@if (!group()) { ... }`, and replace `activate` with:

```ts
  protected activate(): void {
    const params = this.params();
    if (params?.data && !params.node.group)
      params.onDetails(params.data, params.node);
  }
```

- [ ] **Step 5: Add grouping to the grid options**

In `frontend/src/app/devices/device-grid-options.ts`:

1. Add `IRowNode` to the `ag-grid-community` type import. Import `getSsrmRoute` from `@libregrid/server-side-row-model` and `deviceGroupColumn` from `./device-columns`.
2. In the columns tool panel `toolPanelParams`, delete `suppressRowGroups: true,` and change the comment to `// Pivot and aggregation are outside this slice.`
3. Add to the returned options, after `selectionColumnDef`:

```ts
    autoGroupColumnDef: deviceGroupColumn,
    // LibreGrid offers grouping items only to menus that ask for them.
    getColumnMenuItems: (params) => [
      ...params.defaultItems,
      'separator',
      'rowGroup',
      'rowUnGroup',
    ],
```

4. Append:

```ts
/** Where a device sits for Next device: its group and its index there, or its index in the flat grid. */
export function detailsTarget(
  node: Pick<IRowNode, 'rowIndex' | 'sourceRowIndex' | 'parent'>,
): { index: number; route: string[] | null } | null {
  const route = node.parent?.group ? (getSsrmRoute(node.parent) ?? null) : null;
  const index = route ? node.sourceRowIndex : node.rowIndex;
  return index === null || index < 0 ? null : { index, route };
}
```

- [ ] **Step 6: Wire the grid, the page, and the status panel**

In `frontend/src/app/devices/device-grid.ts`:

1. Register `RowGroupingModule` from `@libregrid/row-grouping` after `ServerSideRowModelModule`.
2. Import `type DeviceGroupLoader` from `./device-datasource`, `detailsTarget` from `./device-grid-options`, and `type IRowNode` from `ag-grid-community`.
3. Add the input `readonly loadGroups = input.required<DeviceGroupLoader>();` after `load`, and change the `details` output to `output<{ row: DeviceRow; index: number; route: string[] | null }>()`.
4. In `ngOnInit`, replace `open` with:

```ts
    const open = (row: DeviceRow, node: IRowNode<DeviceRow>) => {
      const target = detailsTarget(node);
      if (target) this.details.emit({ row, ...target });
    };
```

5. In `reload`, pass the group loader as the fourth argument: `(view) => this.loadGroups()(view),`.

In `frontend/src/app/devices/devices.ts`:

1. Add after `load`:

```ts
  protected readonly loadGroups = (view: DeviceView) => {
    this.store.setView(view);
    return this.store.groups(view);
  };
  /** A grouped grid cannot scroll back to a row inside a closed group. */
  protected readonly grouped = computed(
    () => !!this.store.view().group?.by.length,
  );
```

2. Replace `open` with:

```ts
  protected open(event: {
    row: DeviceRow;
    index: number;
    route: string[] | null;
  }): void {
    // Next device follows the opened device's group.
    const view = this.store.view();
    if (event.route)
      this.store.view.set({
        ...view,
        group: { by: view.group?.by ?? [], keys: event.route },
      });
    this.store.position.set({
      index: event.index,
      deviceId: event.row.deviceId,
    });
    void this.router.navigate(['/devices', event.row.deviceId]);
  }
```

In `frontend/src/app/devices/devices.html`, on `app-device-grid`, add `[loadGroups]="loadGroups"` after `[load]="load"`, and replace the `[focusIndex]` binding with `[focusIndex]="grouped() ? null : (store.position()?.index ?? null)"`.

In `frontend/src/app/devices/device-status-panel.ts`, add after the scope paragraph:

```html
      @if (store.groupLimit()) {
      <p>
        Open groups list their first 1,000 devices. Add a filter to see the
        rest.
      </p>
      }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run-many -t lint build -p frontend --skip-nx-cache`
Expected: PASS with no new warnings.

- [ ] **Step 8: Look at the grouped grid**

Rebuild the frontend while the client review environment runs. In headless Chromium with the review administrator, open `/devices` and check:

- The Battery header menu offers "Group by Battery". Choosing it shows one row per class, such as "Replace soon (135)".
- Opening a group lists its devices. The group column header reads "Group".
- The Columns side bar shows the Row Groups area and no pivot or values areas.
- Checking a group row's box selects the whole group. The status bar names it under "Selected groups".
- Opening a device inside the group and choosing Next device shows the group's next device.

Ledger a ruling for any library behavior that differs from this plan, together with its fix.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json frontend/src/app/devices
git commit -m "feat: group the device grid by organization unit, model, and battery"
```

---

### Task 6: Browser check and workflow record

**Files:**
- Modify: `api-e2e/devices-browser.mjs`
- Modify: `docs/workflows/device-browsing.md`
- Modify: `docs/current-work.md`
- Modify: `docs/testing/client-review.md`
- Modify: `docs/document-index.csv`

**Interfaces:**
- Consumes: every earlier task through the real application. At the start of the new steps, no filter is active, the Columns side bar is open, and Serial sorts ascending.

The simulated serials are hexadecimal, and battery classes repeat every three devices. C0A1-0001 and C0A1-0004 are the first two Replace soon devices.

- [ ] **Step 1: Write the browser check**

In `api-e2e/devices-browser.mjs`, insert after `await auditAccessibility(page, 'devices-columns');`:

```js
    // Group by battery class from the column menu (grouping decision).
    await page.getByRole('tab', { name: 'Columns' }).click();
    const groupBy = async (name) => {
      const header = page.getByRole('columnheader', { name: 'Battery' });
      await header.hover();
      await header.locator('.ag-header-cell-menu-button').click();
      await page.getByRole('menuitem', { name }).click();
    };
    await groupBy('Group by Battery');
    const replaceSoonGroup = page.getByRole('button', {
      name: 'Replace soon (135)',
    });
    await expect(replaceSoonGroup).toBeVisible();
    await auditAccessibility(page, 'devices-groups');
    await page
      .getByRole('row', { name: /Replace soon \(135\)/ })
      .getByRole('checkbox')
      .check();
    await expect(page.getByText('Total Selected: 135')).toBeVisible();
    await expect(page.getByText('Selected groups: Replace soon')).toBeVisible();
    await replaceSoonGroup.click();
    await page
      .getByRole('button', { name: 'Open details for C0A1-0001' })
      .click();
    await page.getByRole('button', { name: 'Next device' }).click();
    await expect(
      page.getByRole('heading', { name: 'C0A1-0004', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to devices' }).click();
    await expect(
      page.getByRole('button', { name: 'Replace soon (135)' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Deselect All' }).click();
    await expect(page.getByText('Total Selected: 0')).toBeVisible();
    await groupBy('Stop grouping by Battery');
    await expect(
      page.getByText('450 matching devices · 450 in district'),
    ).toBeVisible();
```

If LibreGrid hides the Battery column while it groups by it, stop grouping from the Row Groups area of the Columns side bar instead, and ledger the ruling.

Add this line to the returned list before the deep-link line:

```js
      'the grid groups by battery class with counts and selects whole groups: pass',
```

- [ ] **Step 2: Run the browser check**

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache > .superpowers/sdd/2026-10-06-device-grid-grouping/task6-e2e.log 2>&1; tail -60 .superpowers/sdd/2026-10-06-device-grid-grouping/task6-e2e.log`
Expected: PASS, with every device accessibility audit passing.

Replay the flow against the client review environment first when a locator is uncertain. Ledger each locator or markup change as a ruling. Do not disable an axe rule.

- [ ] **Step 3: Update the workflow record**

In `docs/workflows/device-browsing.md`:

1. In "Interaction", add after the status bar sentence:

```markdown
The column menu and the Columns side bar group the grid by organization unit, model, or battery class. Each group row shows its device count.
```

2. In "Implementation defaults", add:

```markdown
- Groups nest up to three levels, each field once. Group keys are exact OrgUnit paths, model names, and battery classes. Devices without a model form the group "No model".
- An open group lists up to 1,000 devices, and a grouped level lists up to 1,000 groups. The status bar says when a group holds more.
- While the grid is grouped, checking any row selects or deselects its whole group, as LibreGrid defines. A selected group keeps the filters that were active.
- Next device from a device inside a group follows that group's order. Back to devices restores the grouping, filters, sort, and page. Open groups close.
```

3. In "Completion", add after item 8:

```markdown
9. Group by each of the three fields, open a group, select it, and use Next device inside it.
```

In `docs/current-work.md`, replace `The owner added grid tools, paging, and server-side selection on 2026-10-05.` with `The owner added grid tools, paging, server-side selection, and grouping on 2026-10-05.`

In `docs/testing/client-review.md`, in the Devices item, add after the sentence that ends with "use the Columns side bar.":

```markdown
  Group by Battery from the column menu, open a group, and select it.
```

In `docs/document-index.csv`, set the inspection field of the `docs/workflows/device-browsing.md`, `docs/current-work.md`, and `docs/testing/client-review.md` rows to `"Device grid grouping recorded, 2026-10-06"`.

Preserve the CRLF line endings by editing bytes.

- [ ] **Step 4: Run every check**

Run: `npm exec -- nx run-many -t lint test build -p application-contracts api frontend --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api-e2e/devices-browser.mjs docs/workflows/device-browsing.md docs/current-work.md docs/testing/client-review.md docs/document-index.csv
git commit -m "test: group devices and select whole groups in the browser check"
```

## After this plan

- Restart the client review environment with the new build and give the owner its address.
- The live Easton check still waits for the owner to add both device scopes.
- Follow-ups recorded by the grid features review: feedback when a selection change fails, and per-person bounds on stored selections.
