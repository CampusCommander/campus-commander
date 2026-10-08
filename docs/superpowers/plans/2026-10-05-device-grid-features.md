# Device Grid Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the device grid the LibreGrid features that the owner chose. These are column tools, column filters synced with the chips, paging, a status bar, and server-side selection.

**Architecture:** The grid's filter model becomes the source of truth. A pure mapping turns it into the existing device predicates, and the chips edit it through that mapping. The API keeps each tab's selection in Redis as filter terms plus explicit additions and exceptions. PostgreSQL evaluates the selection inside the device query. The LibreGrid selection provider calls three new endpoints. Counts, freshness, and the selection footer move into the AG Grid status bar.

**Tech Stack:** Angular 22, AG Grid Community 36.2.0, LibreGrid 1.3.5, NestJS, PostgreSQL, Redis (`redis` 5), Zod 4, Vitest, `node:test`, and Playwright.

**Spec:** [docs/workflows/device-browsing.md](../../workflows/device-browsing.md), sections "Grid features", "Paging", and "Filtering" under the owner decisions. UI rules: [GRID-01, GRID-03, and SELECT-01](../../ui/patterns.md). Server-side grouping is a later plan.

## Global Constraints

- Use exactly `ag-grid-community@36.2.0`, `ag-grid-angular@36.2.0`, and LibreGrid `1.3.5`.
  The packages are `server-side-row-model`, `server-side-selection`, `menu`, `side-bar`, `columns-tool-panel`, `filters-tool-panel`, `set-filter`, and `status-bar`.
  Register grid modules in `device-grid.ts`, the lazily loaded devices code. Do not register `ContextMenuModule`, clipboard, Excel export, or cell selection.
- Pages hold 100 devices by default. The page size selector offers 50, 100, and 250.
- One filter per column. Chips and column filters stay in sync and drive one server query.
- Battery and OrgUnit use set filters. Text fields offer contains, starts with, equals, and blank. Device contact offers Before and On or after.
- Selection keys are storage keys, not authorization. The API scopes every selection to the signed-in person and requires `devices:read`.
- The browser never holds the full selection. It sends at most 2,000 device IDs per operation.
- Selection excludes Refresh selected and Bulk Actions. They arrive with the first device action.
- Call the API only through `AuthStore.request`. Use the existing `--cc-*` tokens.
- Repository prose follows the writing rules in `AGENTS.md`.
- Run tasks through Nx: `npm exec -- nx run <project>:<target> --skip-nx-cache`.

## Review Focus

1. **Filters change after Select All.** The selection keeps its count, and Clear filters does not clear it. Tests: Task 2 Select All test, Task 8 browser check.
2. **Show All Selected finds nothing under the current filters.** The grid and its footer stay visible, so the administrator can return to all records. Test: Task 7 page test.
3. **A chip for a field that already has a column filter.** The chip replaces that filter. It does not add a second one. Tests: Task 4 canonical test, Task 6 page test.
4. **Next device crosses a page boundary, then Back to devices.** The grid opens the page that holds the new row. Tests: Task 7 `showRow` test, Task 8 browser check.
5. **Two selection changes for one tab arrive together.** Neither change is lost. Test: Task 2 concurrent change test.

---

### Task 1: OrgUnit set predicate end to end

**Files:**

- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`
- Modify: `frontend/src/app/devices/device-fields.ts`
- Modify: `frontend/src/app/devices/device-fields.spec.ts`
- Modify: `frontend/src/app/devices/device-filter.ts`
- Modify: `frontend/src/app/devices/device-filter.html`
- Modify: `frontend/src/app/devices/device-filter.spec.ts`
- Modify: `api-e2e/devices-api.mjs`

**Interfaces:**

- Produces: the OrgUnit predicate `{ field: 'orgUnitPath'; operator: 'in'; values: string[] }`, with at most 1,000 paths. It matches devices whose OrgUnit path equals one of the values. The `equals` and `within` operators are removed.
- Produces: battery and OrgUnit predicates accept an empty `values` array. An empty set matches no devices.
- Produces: in `device-fields.ts`, `unitsWithin(units, path): string[]`, `unitCheck(selected, units, path): 'checked' | 'mixed' | 'unchecked'`, and `withUnit(selected, units, path, checked): string[]`. `ORG_UNIT_OPERATORS` is removed.

A set filter lists exact values, so the predicate matches exact paths. The OrgUnit tree in the filter row selects a unit together with the units inside it.

- [ ] **Step 1: Write the failing tests**

In `libs/application-contracts/src/lib/devices.test.mjs`, in the test `predicates accept only the operators of their field type`, replace these three assertions:

```js
assert.equal(ok({ field: 'battery', operator: 'is', values: [] }), false);
assert.equal(
  ok({ field: 'orgUnitPath', operator: 'within', value: 'School A' }),
  false,
);
assert.equal(
  ok({ field: 'orgUnitPath', operator: 'within', value: '/School A' }),
  true,
);
```

with:

```js
// An empty set filter is valid. It matches no devices.
assert.equal(ok({ field: 'battery', operator: 'is', values: [] }), true);
assert.equal(
  ok({ field: 'orgUnitPath', operator: 'in', values: ['School A'] }),
  false,
);
assert.equal(
  ok({ field: 'orgUnitPath', operator: 'in', values: ['/School A', '/'] }),
  true,
);
assert.equal(ok({ field: 'orgUnitPath', operator: 'in', values: [] }), true);
assert.equal(
  ok({ field: 'orgUnitPath', operator: 'within', value: '/School A' }),
  false,
);
```

In `api/src/app/devices/device-query.test.mjs`, in `filter values never enter the SQL text`, replace the OrgUnit predicate with:

```js
      { field: 'orgUnitPath', operator: 'in', values: [`/${hostile}`] },
```

Replace the whole test `organization unit scope includes descendants and treats root as everything` with:

```js
test('organization unit filters match the chosen paths exactly', () => {
  const { rows } = query({
    predicates: [
      { field: 'orgUnitPath', operator: 'in', values: ['/School A', '/'] },
    ],
  });
  assert.match(rows.text, /AND d\.org_unit_path=ANY\(\$2::text\[\]\) ORDER BY/);
  assert.deepEqual(rows.values[1], ['/School A', '/']);
});

test('an empty set filter matches no devices', () => {
  const battery = query({
    predicates: [{ field: 'battery', operator: 'is', values: [] }],
  });
  assert.match(
    battery.rows.text,
    /WHERE s\.customer_id=\$1 AND FALSE ORDER BY/,
  );
  const units = query({
    predicates: [{ field: 'orgUnitPath', operator: 'in', values: [] }],
  });
  assert.deepEqual(units.rows.values[1], []);
});
```

In `frontend/src/app/devices/device-fields.spec.ts`, add `unitCheck`, `unitsWithin`, and `withUnit` to the import from `./device-fields`. In `labels each filter type the way the chips read`, replace the OrgUnit case with these cases:

```ts
      [
        { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
        'Organization unit · /School A',
      ],
      [
        {
          field: 'orgUnitPath',
          operator: 'in',
          values: ['/A', '/B', '/C', '/D'],
        },
        'Organization unit · 4 units',
      ],
      [{ field: 'battery', operator: 'is', values: [] }, 'Battery · none'],
```

Append to the same file:

```ts
it('selects an organization unit together with the units inside it', () => {
  const units = [
    { path: '/', devices: 2 },
    { path: '/School A', devices: 5 },
    { path: '/School A/Library', devices: 3 },
    { path: '/School AB', devices: 1 },
  ];
  expect(unitsWithin(units, '/School A')).toEqual([
    '/School A',
    '/School A/Library',
  ]);
  expect(unitsWithin(units, '/')).toHaveLength(4);
  const chosen = withUnit([], units, '/School A', true);
  expect(chosen).toEqual(['/School A', '/School A/Library']);
  expect(unitCheck(chosen, units, '/School A')).toBe('checked');
  expect(unitCheck(chosen, units, '/')).toBe('mixed');
  expect(unitCheck(chosen, units, '/School AB')).toBe('unchecked');
  expect(withUnit(chosen, units, '/School A/Library', false)).toEqual([
    '/School A',
  ]);
});
```

In `frontend/src/app/devices/device-filter.spec.ts`, replace the test `applies an organization unit including its descendants` with:

```ts
it('applies an organization unit with the units inside it', () => {
  const { element, applied, click, button, start } = setup([
    { path: '/School A', devices: 5 },
    { path: '/School A/Library', devices: 3 },
    { path: '/School B', devices: 4 },
  ]);
  start('organ');
  click(element.querySelectorAll('[role="option"]')[0]);
  const labels = [...element.querySelectorAll('.unit')].map((unit) =>
    unit.textContent?.trim(),
  );
  expect(labels).toEqual([
    'All organization units',
    'School A',
    'Library',
    'School B',
  ]);
  const boxes = () => [
    ...element.querySelectorAll<HTMLInputElement>('.unit input'),
  ];
  expect(button('Apply').disabled).toBe(true);
  click(boxes()[1]);
  expect(boxes().map((box) => box.checked)).toEqual([false, true, true, false]);
  expect(boxes()[0].indeterminate).toBe(true);
  click(button('Apply'));
  expect(applied).toEqual([
    {
      field: 'orgUnitPath',
      operator: 'in',
      values: ['/School A', '/School A/Library'],
    },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run application-contracts:test --skip-nx-cache`
Expected: FAIL. The schema still rejects an empty battery set and the `in` operator.

Run: `npm exec -- nx run api:test --skip-nx-cache`
Expected: FAIL. `deviceQuerySchema` rejects the `in` predicate.

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `unitsWithin` is not exported, and the test types reject `operator: 'in'`.

- [ ] **Step 3: Change the contract**

In `libs/application-contracts/src/lib/devices.ts`, replace the OrgUnit and battery members of `devicePredicateSchema` with:

```ts
  z.strictObject({
    field: z.literal('orgUnitPath'),
    operator: z.literal('in'),
    values: z.array(orgUnitPath).max(1000),
  }),
  z.strictObject({
    field: z.literal('battery'),
    operator: z.literal('is'),
    values: z.array(batteryFilterValueSchema).max(5),
  }),
```

- [ ] **Step 4: Change the query builder**

In `api/src/app/devices/device-query.ts`, in `deviceWhere`, replace the `orgUnitPath` branch with:

```ts
    if (predicate.field === 'orgUnitPath') {
      clauses.push(`d.org_unit_path=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'battery') {
```

In the battery branch, replace `clauses.push(`(${parts.join(' OR ')})`);` with:

```ts
clauses.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
```

- [ ] **Step 5: Change the chip label and add the OrgUnit tree helpers**

In `frontend/src/app/devices/device-fields.ts`, delete `ORG_UNIT_OPERATORS`. In `chipLabel`, replace the battery and OrgUnit lines with:

```ts
if (predicate.field === 'battery')
  return `${label} · ${
    predicate.values.length
      ? predicate.values.map((value) => BATTERY_LABELS[value]).join(', ')
      : 'none'
  }`;
if (predicate.field === 'orgUnitPath')
  return `${label} · ${
    predicate.values.length === 0
      ? 'none'
      : predicate.values.length <= 3
        ? predicate.values.join(', ')
        : `${predicate.values.length} units`
  }`;
```

Append after `orgUnitOptions`:

```ts
/** Organization units with devices at or below a path. The root contains every unit. */
export function unitsWithin(
  units: readonly DeviceOrgUnit[],
  path: string,
): string[] {
  return units
    .map((unit) => unit.path)
    .filter(
      (candidate) =>
        path === '/' || candidate === path || candidate.startsWith(`${path}/`),
    );
}

export type UnitCheck = 'checked' | 'mixed' | 'unchecked';

export function unitCheck(
  selected: readonly string[],
  units: readonly DeviceOrgUnit[],
  path: string,
): UnitCheck {
  const inside = unitsWithin(units, path);
  const chosen = inside.filter((candidate) =>
    selected.includes(candidate),
  ).length;
  if (chosen === 0) return 'unchecked';
  return chosen === inside.length ? 'checked' : 'mixed';
}

/** Choosing a unit chooses the units inside it, so the filter covers the subtree. */
export function withUnit(
  selected: readonly string[],
  units: readonly DeviceOrgUnit[],
  path: string,
  checked: boolean,
): string[] {
  const inside = new Set(unitsWithin(units, path));
  const rest = selected.filter((candidate) => !inside.has(candidate));
  return (checked ? [...rest, ...inside] : rest).sort((a, b) =>
    a.localeCompare(b),
  );
}
```

- [ ] **Step 6: Change the OrgUnit editor**

In `frontend/src/app/devices/device-filter.ts`:

1. In the import from `./device-fields`, remove `ORG_UNIT_OPERATORS` and add `unitCheck` and `withUnit`.
2. Delete the `orgUnitOperators` field.
3. After the `battery` signal, add:

```ts
  protected readonly unitValues = signal<readonly string[]>([]);
```

4. Replace the `draft` computed with:

```ts
  protected readonly draft = computed<DevicePredicate | null>(() => {
    const field = this.field();
    if (!field) return null;
    const candidate =
      field.kind === 'battery'
        ? { field: field.id, operator: 'is', values: this.battery() }
        : field.kind === 'orgUnit'
          ? { field: field.id, operator: 'in', values: this.unitValues() }
          : field.kind === 'date'
            ? {
                field: field.id,
                operator: this.operator(),
                value: dateInputToIso(this.value()),
              }
            : this.operator() === 'isEmpty'
              ? { field: field.id, operator: 'isEmpty' }
              : {
                  field: field.id,
                  operator: this.operator(),
                  value: this.value(),
                };
    const parsed = devicePredicateSchema.safeParse(candidate);
    if (!parsed.success) return null;
    // Only grid set filters may be empty. A chip needs at least one value.
    return 'values' in parsed.data && parsed.data.values.length === 0
      ? null
      : parsed.data;
  });
```

5. In `openField`, replace the `this.operator.set(...)` call with the following. After `this.battery.set([]);`, add `this.unitValues.set([]);`.

```ts
this.operator.set(
  field.kind === 'orgUnit'
    ? 'in'
    : field.kind === 'date'
      ? 'before'
      : 'contains',
);
```

6. In `open`, replace the value branches with:

```ts
if (predicate.field === 'battery') this.battery.set(predicate.values);
else if (predicate.field === 'orgUnitPath')
  this.unitValues.set(predicate.values);
else if (predicate.field === 'lastContact')
  this.value.set(dateInputValue(predicate.value));
else if ('value' in predicate) this.value.set(predicate.value);
```

7. After `toggleBattery`, add:

```ts
  protected unitState(path: string) {
    return unitCheck(this.unitValues(), this.orgUnits(), path);
  }

  protected chooseUnit(path: string, checked: boolean): void {
    this.unitValues.set(
      withUnit(this.unitValues(), this.orgUnits(), path, checked),
    );
  }
```

In `frontend/src/app/devices/device-filter.html`, replace the whole `@case ('orgUnit') { ... }` block with:

```html
} @case ('orgUnit') {
<label class="field"
  >Find an organization unit
  <input
    type="search"
    [value]="unitSearch()"
    (input)="unitSearch.set($any($event.target).value)"
/></label>
<fieldset class="units">
  <legend>Organization units</legend>
  @for (unit of units(); track unit.path) {
  <label class="unit" [style.padding-inline-start.px]="unit.depth * 16"
    ><input
      type="checkbox"
      [checked]="unitState(unit.path) === 'checked'"
      [indeterminate]="unitState(unit.path) === 'mixed'"
      (change)="chooseUnit(unit.path, $any($event.target).checked)"
    />{{ unit.label }}</label
  >
  } @empty {
  <p>No organization units match.</p>
  }
</fieldset>
<p class="hint">Choosing a unit includes the units inside it.</p>
} @case ('date') {
```

- [ ] **Step 7: Change the API check**

In `api-e2e/devices-api.mjs`, replace the OrgUnit predicate in the query that expects 150 matches with:

```js
            { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm exec -- nx run-many -t test -p application-contracts api frontend --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run frontend:lint --skip-nx-cache`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add libs/application-contracts api/src/app/devices frontend/src/app/devices api-e2e/devices-api.mjs
git commit -m "feat: filter devices by a set of organization units"
```

---

### Task 2: Selection contracts, selection SQL, and selection state

**Files:**

- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`
- Create: `api/src/app/devices/device-selection.ts`
- Create: `api/src/app/devices/device-selection.test.mjs`

**Interfaces:**

- Consumes: the Task 1 predicates.
- Produces: in `@campus/application-contracts`:
  - `deviceSelectionKeySchema` and type `DeviceSelectionKey = { gridId: 'devices'; tabId: string }`. `tabId` is a UUID.
  - `deviceSelectionOpSchema` and type `DeviceSelectionOp`. The four operations are `{ op: 'selectAll'; predicates }`, `{ op: 'deselectAll' }`, `{ op: 'select'; ids }`, and `{ op: 'deselect'; ids }`. `ids` holds 1 to 2,000 device IDs.
  - `deviceSelectionChangeSchema`: a key plus `ops`, with 1 to 100 operations.
  - `deviceSelectionResolveSchema`: a key plus `rowIds` (at most 2,000) and `groupRoutes` (at most 2,000).
  - `deviceSelectionSpecSchema` and type `DeviceSelectionSpec = { terms: { type: 'all'; predicates }[]; added: number; excluded: number; selectedCount: number }`.
  - `deviceQuerySchema` gains `selection: DeviceSelectionKey | null`, which defaults to `null`.
- Produces: in `api/src/app/devices/device-query.ts`, `devicePageSql(customerId, query, selection: SelectionState | null = null)`, `selectionCountSql(customerId, state)`, `selectedAmongSql(customerId, state, ids)`, and `matchingAmongSql(customerId, predicates, ids)`. Each returns a `SqlStatement`. The count column is `selected`. The membership statements return `device_id` rows.
- Produces: in `api/src/app/devices/device-selection.ts`, these exports:
  - `SELECTION_SECONDS = 43200`.
  - type `SelectionState = { terms: DevicePredicate[][]; additions: string[]; exceptions: string[] }`.
  - `emptySelection()`, `parseSelection(raw)`, and `selectionStorageKey(identityId, key)`.
  - `applySelectionOps(state, ops, matching)` and `changeSelection(cache, key, change)`.
  - `selectionSpec(state, selectedCount)`, `SelectionTooLargeError`, and `SelectionBusyError`.

The selection follows the LibreGrid contract. Terms accumulate. Select All clears the exceptions in its scope. A deselected device stays deselected until a row select or a Select All covers it again.

- [ ] **Step 1: Write the failing contract tests**

In `libs/application-contracts/src/lib/devices.test.mjs`, add `deviceSelectionChangeSchema` and `deviceSelectionKeySchema` to the import from `./devices.ts`. In `device queries default to the first serial page`, add `selection: null,` after `limit: 100,` in the expected object. Append:

```js
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

test('selection keys name the device grid and a tab UUID', () => {
  const key = { gridId: 'devices', tabId };
  assert.equal(deviceSelectionKeySchema.safeParse(key).success, true);
  assert.equal(
    deviceSelectionKeySchema.safeParse({ ...key, gridId: 'users' }).success,
    false,
  );
  assert.equal(
    deviceSelectionKeySchema.safeParse({ ...key, tabId: 'tab-1' }).success,
    false,
  );
  assert.deepEqual(deviceQuerySchema.parse({ selection: key }).selection, key);
});

test('selection changes accept the four row operations within bounds', () => {
  const ok = (ops) =>
    deviceSelectionChangeSchema.safeParse({ gridId: 'devices', tabId, ops })
      .success;
  assert.equal(
    ok([
      {
        op: 'selectAll',
        predicates: [
          { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
        ],
      },
      { op: 'deselect', ids: ['d1'] },
      { op: 'select', ids: ['d2'] },
      { op: 'deselectAll' },
    ]),
    true,
  );
  assert.equal(ok([]), false);
  assert.equal(ok([{ op: 'select', ids: [] }]), false);
  assert.equal(ok([{ op: 'select', ids: Array(2001).fill('d') }]), false);
  assert.equal(ok([{ op: 'selectGroup', route: ['/School A'] }]), false);
});
```

- [ ] **Step 2: Write the failing query and state tests**

In `api/src/app/devices/device-query.test.mjs`, add `matchingAmongSql`, `selectedAmongSql`, and `selectionCountSql` to the import from `./device-query.ts`. Append:

```js
const selection = {
  terms: [[{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }]],
  additions: ['d9'],
  exceptions: ['d1'],
};

test('a selection holds its filter terms and additions minus exceptions', () => {
  const sql = selectionCountSql('C0123456', selection);
  assert.ok(sql.text.startsWith('SELECT count(*)::integer AS selected FROM'));
  assert.ok(
    sql.text.endsWith(
      'WHERE s.customer_id=$1 AND (((d.asset_tag ILIKE $2) OR d.device_id=ANY($3::text[])) AND NOT d.device_id=ANY($4::text[]))',
    ),
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', ['d9'], ['d1']]);
});

test('an empty selection holds nothing and an unfiltered term holds everything', () => {
  const empty = { terms: [], additions: [], exceptions: [] };
  assert.match(selectionCountSql('C0123456', empty).text, /AND FALSE$/);
  assert.match(
    selectionCountSql('C0123456', { ...empty, terms: [[]] }).text,
    /AND \(TRUE\)$/,
  );
});

test('the selected view intersects the selection with the active filters', () => {
  const { count } = devicePageSql(
    'C0123456',
    deviceQuerySchema.parse({
      predicates: [{ field: 'model', operator: 'contains', value: 'Lenovo' }],
    }),
    selection,
  );
  assert.ok(
    count.text.endsWith(
      'WHERE s.customer_id=$1 AND d.model ILIKE $2 AND (((d.asset_tag ILIKE $3) OR d.device_id=ANY($4::text[])) AND NOT d.device_id=ANY($5::text[]))',
    ),
  );
  assert.deepEqual(count.values, [
    'C0123456',
    '%Lenovo%',
    'HS-04%',
    ['d9'],
    ['d1'],
  ]);
});

test('membership checks bind the device IDs after the customer', () => {
  const among = selectedAmongSql('C0123456', selection, ['d1', 'd2']);
  assert.ok(
    among.text.startsWith('SELECT d.device_id FROM cc.device_sync_state s'),
  );
  assert.ok(among.text.endsWith('AND d.device_id=ANY($2::text[])'));
  assert.deepEqual(among.values.slice(0, 2), ['C0123456', ['d1', 'd2']]);
  const matching = matchingAmongSql(
    'C0123456',
    [{ field: 'model', operator: 'contains', value: 'Lenovo' }],
    ['d1'],
  );
  assert.ok(
    matching.text.endsWith(
      'WHERE s.customer_id=$1 AND d.model ILIKE $3 AND d.device_id=ANY($2::text[])',
    ),
  );
  assert.deepEqual(matching.values, ['C0123456', ['d1'], '%Lenovo%']);
});
```

Create `api/src/app/devices/device-selection.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SelectionBusyError,
  SelectionTooLargeError,
  applySelectionOps,
  changeSelection,
  emptySelection,
  parseSelection,
  selectionSpec,
  selectionStorageKey,
} from './device-selection.ts';

const hs04 = [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }];
const lenovo = [{ field: 'model', operator: 'contains', value: 'Lenovo' }];
const none = async () => [];

test('select and deselect move devices between additions and exceptions', async () => {
  let state = await applySelectionOps(
    emptySelection(),
    [{ op: 'select', ids: ['d1', 'd2'] }],
    none,
  );
  assert.deepEqual(state, {
    terms: [],
    additions: ['d1', 'd2'],
    exceptions: [],
  });
  state = await applySelectionOps(
    state,
    [{ op: 'deselect', ids: ['d1'] }],
    none,
  );
  assert.deepEqual(state, { terms: [], additions: ['d2'], exceptions: [] });
});

test('Select All keeps earlier terms and clears only the exceptions in its scope', async () => {
  const calls = [];
  const matching = async (predicates, ids) => {
    calls.push([predicates, ids]);
    return ids.filter((id) => id === 'd1');
  };
  const state = await applySelectionOps(
    { terms: [lenovo], additions: [], exceptions: ['d1', 'd7'] },
    [
      { op: 'selectAll', predicates: hs04 },
      { op: 'selectAll', predicates: hs04 },
    ],
    matching,
  );
  assert.deepEqual(calls[0], [hs04, ['d1', 'd7']]);
  assert.deepEqual(state.terms, [lenovo, hs04]);
  assert.deepEqual(state.exceptions, ['d7']);
});

test('deselecting under a filter term records an exception', async () => {
  const state = await applySelectionOps(
    { terms: [hs04], additions: [], exceptions: [] },
    [
      { op: 'deselect', ids: ['d1'] },
      { op: 'select', ids: ['d2'] },
    ],
    none,
  );
  assert.deepEqual(state, {
    terms: [hs04],
    additions: ['d2'],
    exceptions: ['d1'],
  });
  assert.deepEqual(
    await applySelectionOps(state, [{ op: 'deselectAll' }], none),
    emptySelection(),
  );
});

test('a selection beyond its bounds is refused', async () => {
  const terms = Array.from({ length: 50 }, (_, index) => [
    { field: 'model', operator: 'equals', value: `m${index}` },
  ]);
  await assert.rejects(
    applySelectionOps(
      { terms, additions: [], exceptions: [] },
      [{ op: 'selectAll', predicates: hs04 }],
      none,
    ),
    SelectionTooLargeError,
  );
});

test('selections belong to one person, grid, and tab', () => {
  assert.equal(
    selectionStorageKey('person-1', { gridId: 'devices', tabId: 't1' }),
    'device-selection:person-1:devices:t1',
  );
});

test('a missing or unreadable stored selection reads as empty', () => {
  assert.deepEqual(parseSelection(null), emptySelection());
  assert.deepEqual(parseSelection('{bad'), emptySelection());
  assert.deepEqual(
    parseSelection(JSON.stringify({ terms: 'x' })),
    emptySelection(),
  );
});

test('a concurrent change makes the write retry from the newer value', async () => {
  const stored = [
    JSON.stringify({ terms: [], additions: ['d1'], exceptions: [] }),
    JSON.stringify({ terms: [], additions: ['d1', 'd5'], exceptions: [] }),
  ];
  let reads = 0;
  const writes = [];
  const cache = {
    get: async () => stored[Math.min(reads++, 1)],
    swap: async (key, expected, value, seconds) => {
      writes.push({ key, expected, value, seconds });
      return writes.length === 2;
    },
  };
  const state = await changeSelection(cache, 'k', (current) =>
    applySelectionOps(current, [{ op: 'select', ids: ['d2'] }], none),
  );
  assert.deepEqual(state.additions, ['d1', 'd5', 'd2']);
  assert.equal(writes[1].expected, stored[1]);
  assert.equal(writes[1].seconds, 43_200);
});

test('a selection that keeps changing underneath reports busy', async () => {
  const cache = { get: async () => null, swap: async () => false };
  await assert.rejects(
    changeSelection(cache, 'k', async (state) => state),
    SelectionBusyError,
  );
});

test('the spec reports terms and counts without device IDs', () => {
  assert.deepEqual(
    selectionSpec(
      { terms: [hs04], additions: ['d2'], exceptions: ['d1', 'd3'] },
      95,
    ),
    {
      terms: [{ type: 'all', predicates: hs04 }],
      added: 1,
      excluded: 2,
      selectedCount: 95,
    },
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm exec -- nx run application-contracts:test --skip-nx-cache`
Expected: FAIL. `deviceSelectionKeySchema` is not exported.

Run: `npm exec -- nx run api:test --skip-nx-cache`
Expected: FAIL. `selectionCountSql` is not exported, and `./device-selection.ts` does not exist.

- [ ] **Step 4: Add the selection contracts**

In `libs/application-contracts/src/lib/devices.ts`, insert before `export const deviceQuerySchema`:

```ts
const selectionIds = z.array(deviceId).min(1).max(2000);
const selectionKeyShape = {
  gridId: z.literal('devices'),
  tabId: z.uuid(),
};
/** One browser tab's selection in one grid. The API scopes it to the signed-in person. */
export const deviceSelectionKeySchema = z.strictObject(selectionKeyShape);
export type DeviceSelectionKey = z.infer<typeof deviceSelectionKeySchema>;

export const deviceSelectionOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('selectAll'),
    predicates: z.array(devicePredicateSchema).max(20),
  }),
  z.strictObject({ op: z.literal('deselectAll') }),
  z.strictObject({ op: z.literal('select'), ids: selectionIds }),
  z.strictObject({ op: z.literal('deselect'), ids: selectionIds }),
]);
export type DeviceSelectionOp = z.infer<typeof deviceSelectionOpSchema>;

export const deviceSelectionChangeSchema = z.strictObject({
  ...selectionKeyShape,
  ops: z.array(deviceSelectionOpSchema).min(1).max(100),
});

export const deviceSelectionResolveSchema = z.strictObject({
  ...selectionKeyShape,
  rowIds: z.array(deviceId).max(2000),
  groupRoutes: z.array(z.string().max(8192)).max(2000),
});

/** What Select All captured and the API's count. Device IDs stay on the server. */
export const deviceSelectionSpecSchema = z.strictObject({
  terms: z
    .array(
      z.strictObject({
        type: z.literal('all'),
        predicates: z.array(devicePredicateSchema).max(20),
      }),
    )
    .max(50),
  added: z.number().int().min(0),
  excluded: z.number().int().min(0),
  selectedCount: z.number().int().min(0),
});
export type DeviceSelectionSpec = z.infer<typeof deviceSelectionSpecSchema>;
```

In `deviceQuerySchema`, add after the `limit` member:

```ts
  /** Show All Selected limits the query to this tab's selection. */
  selection: deviceSelectionKeySchema.nullable().default(null),
```

- [ ] **Step 5: Add the selection SQL**

In `api/src/app/devices/device-query.ts`, add after the imports:

```ts
import type { SelectionState } from './device-selection';
```

Replace `deviceWhere` with these functions:

```ts
type Add = (value: unknown) => string;

function adder(values: unknown[]): Add {
  return (value) => {
    values.push(value);
    return `$${values.length}`;
  };
}

/** Field names map to fixed columns. Values travel only as parameters. */
function predicateClauses(
  predicates: readonly DevicePredicate[],
  add: Add,
): string[] {
  const clauses: string[] = [];
  for (const predicate of predicates) {
    if (predicate.field === 'orgUnitPath') {
      clauses.push(`d.org_unit_path=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'battery') {
      const health = predicate.values.filter((value) =>
        healthValues.has(value),
      );
      const missing = predicate.values.filter(
        (value) => !healthValues.has(value),
      );
      const parts: string[] = [];
      if (health.length)
        parts.push(
          `(s.telemetry_failure IS NULL AND d.battery_status='reported' AND d.battery_health=ANY(${add(health)}::text[]))`,
        );
      if (missing.length)
        parts.push(`${batteryStatus}=ANY(${add(missing)}::text[])`);
      clauses.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
    } else if (predicate.field === 'lastContact') {
      clauses.push(
        `d.last_contact ${predicate.operator === 'before' ? '<' : '>='} ${add(predicate.value)}::timestamptz`,
      );
    } else {
      const column = columns[predicate.field];
      if (predicate.operator === 'isEmpty')
        clauses.push(`(${column} IS NULL OR ${column}='')`);
      else if (predicate.operator === 'equals')
        clauses.push(`lower(${column})=lower(${add(predicate.value)})`);
      else
        clauses.push(
          `${column} ILIKE ${add(
            predicate.operator === 'contains'
              ? `%${escapeLike(predicate.value)}%`
              : `${escapeLike(predicate.value)}%`,
          )}`,
        );
    }
  }
  return clauses;
}

/** Selected devices: any filter term or explicit addition, minus exceptions. */
function selectedClause(state: SelectionState, add: Add): string {
  const parts = state.terms.map((term) => {
    const clauses = predicateClauses(term, add);
    return clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
  });
  if (state.additions.length)
    parts.push(`d.device_id=ANY(${add(state.additions)}::text[])`);
  if (!parts.length) return 'FALSE';
  const chosen = `(${parts.join(' OR ')})`;
  return state.exceptions.length
    ? `(${chosen} AND NOT d.device_id=ANY(${add(state.exceptions)}::text[]))`
    : chosen;
}

function deviceWhere(
  predicates: readonly DevicePredicate[],
  values: unknown[],
  selection: SelectionState | null = null,
): string {
  const add = adder(values);
  const clauses = ['s.customer_id=$1', ...predicateClauses(predicates, add)];
  if (selection) clauses.push(selectedClause(selection, add));
  return clauses.join(' AND ');
}
```

The loop body is the old `deviceWhere` body with the Task 1 changes. Only its home moved.

Change `devicePageSql` to accept the selection and pass it on:

```ts
export function devicePageSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null = null,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection);
```

Keep the rest of `devicePageSql` as it is. Append:

```ts
export function selectionCountSql(
  customerId: string,
  selection: SelectionState,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere([], values, selection);
  return {
    text: `SELECT count(*)::integer AS selected ${from} WHERE ${where}`,
    values,
  };
}

/** Which of the given devices the selection holds. */
export function selectedAmongSql(
  customerId: string,
  selection: SelectionState,
  ids: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = deviceWhere([], values, selection);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.device_id=ANY($2::text[])`,
    values,
  };
}

/** Which of the given devices match a filter. Select All clears these exceptions. */
export function matchingAmongSql(
  customerId: string,
  predicates: readonly DevicePredicate[],
  ids: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = deviceWhere(predicates, values);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.device_id=ANY($2::text[])`,
    values,
  };
}
```

- [ ] **Step 6: Add the selection state**

Create `api/src/app/devices/device-selection.ts`:

```ts
import { z } from 'zod';
import {
  devicePredicateSchema,
  type DevicePredicate,
  type DeviceSelectionKey,
  type DeviceSelectionOp,
  type DeviceSelectionSpec,
} from '@campus/application-contracts';

/** A selection expires 12 hours after its last change. */
export const SELECTION_SECONDS = 12 * 60 * 60;
const maxTerms = 50;
const maxIds = 200_000;
const deviceIds = z.array(z.string().min(1).max(128)).max(maxIds);

const selectionStateSchema = z.strictObject({
  terms: z.array(z.array(devicePredicateSchema).max(20)).max(maxTerms),
  additions: deviceIds,
  exceptions: deviceIds,
});
export type SelectionState = z.infer<typeof selectionStateSchema>;

export class SelectionTooLargeError extends Error {}
export class SelectionBusyError extends Error {}

export function emptySelection(): SelectionState {
  return { terms: [], additions: [], exceptions: [] };
}

export function selectionStorageKey(
  identityId: string,
  key: DeviceSelectionKey,
): string {
  return `device-selection:${identityId}:${key.gridId}:${key.tabId}`;
}

/** A missing, expired, or unreadable selection is empty. */
export function parseSelection(raw: string | null): SelectionState {
  if (!raw) return emptySelection();
  try {
    const parsed = selectionStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptySelection();
  } catch {
    return emptySelection();
  }
}

const union = (current: readonly string[], ids: readonly string[]) => [
  ...new Set([...current, ...ids]),
];
const sameTerm = (
  a: readonly DevicePredicate[],
  b: readonly DevicePredicate[],
) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one batch of grid selection operations.
 * `matching` returns which of the given devices match a filter.
 */
export async function applySelectionOps(
  state: SelectionState,
  ops: readonly DeviceSelectionOp[],
  matching: (predicates: DevicePredicate[], ids: string[]) => Promise<string[]>,
): Promise<SelectionState> {
  let { terms, additions, exceptions } = state;
  for (const op of ops) {
    if (op.op === 'deselectAll') {
      terms = [];
      additions = [];
      exceptions = [];
    } else if (op.op === 'selectAll') {
      if (exceptions.length) {
        const inScope = new Set(await matching(op.predicates, exceptions));
        exceptions = exceptions.filter((id) => !inScope.has(id));
      }
      if (!terms.some((term) => sameTerm(term, op.predicates)))
        terms = [...terms, op.predicates];
    } else if (op.op === 'select') {
      const ids = new Set(op.ids);
      exceptions = exceptions.filter((id) => !ids.has(id));
      additions = union(additions, op.ids);
    } else {
      const ids = new Set(op.ids);
      additions = additions.filter((id) => !ids.has(id));
      // Only a filter term can still hold a deselected device.
      if (terms.length) exceptions = union(exceptions, op.ids);
    }
  }
  if (
    terms.length > maxTerms ||
    additions.length > maxIds ||
    exceptions.length > maxIds
  )
    throw new SelectionTooLargeError();
  return { terms, additions, exceptions };
}

export interface SelectionCache {
  get(key: string): Promise<string | null>;
  swap(
    key: string,
    expected: string | null,
    value: string,
    seconds: number,
  ): Promise<boolean>;
}

/** Read, change, and write a selection. A concurrent write makes the change retry from the newer value. */
export async function changeSelection(
  cache: SelectionCache,
  key: string,
  change: (state: SelectionState) => Promise<SelectionState>,
): Promise<SelectionState> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await cache.get(key);
    const next = await change(parseSelection(raw));
    if (await cache.swap(key, raw, JSON.stringify(next), SELECTION_SECONDS))
      return next;
  }
  throw new SelectionBusyError();
}

export function selectionSpec(
  state: SelectionState,
  selectedCount: number,
): DeviceSelectionSpec {
  return {
    terms: state.terms.map((predicates) => ({ type: 'all', predicates })),
    added: state.additions.length,
    excluded: state.exceptions.length,
    selectedCount,
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add libs/application-contracts api/src/app/devices
git commit -m "feat: evaluate device selections in the device query"
```

---

### Task 3: Selection endpoints and edge routes

**Files:**

- Modify: `api/src/app/cache/cache.service.ts`
- Modify: `api/src/app/devices/devices.module.ts`
- Modify: `api/src/app/devices/devices.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Modify: `deployment/bootstrap/application-edge.mjs`
- Modify: `deployment/bootstrap/application-edge.test.mjs`
- Modify: `api-e2e/devices-api.mjs`

**Interfaces:**

- Consumes: the Task 2 contracts, SQL builders, and selection state functions.
- Produces: `CacheService.swap(key, expected: string | null, value, seconds): Promise<boolean>`. It writes only if the stored value still equals `expected`. A `null` value for `expected` requires the key to be absent.
- Produces: three endpoints. Each requires `devices:read` and returns status 200.

| Endpoint                              | Body                           | Response                                |
| ------------------------------------- | ------------------------------ | --------------------------------------- |
| `POST /api/devices/selection`         | `DeviceSelectionKey`           | `{ selection: DeviceSelectionSpec }`    |
| `POST /api/devices/selection/ops`     | `deviceSelectionChangeSchema`  | `{ selection: DeviceSelectionSpec }`    |
| `POST /api/devices/selection/resolve` | `deviceSelectionResolveSchema` | `{ selected: Record<string, boolean> }` |

A too-large selection returns 409 with `{ reason: 'selection-too-large' }`. Repeated concurrent changes return 409 with `{ reason: 'selection-busy' }`.

- Produces: `POST /api/devices/query` honors `selection`. It limits the rows and the matching count to the selection.

- [ ] **Step 1: Write the failing edge test**

In `deployment/bootstrap/application-edge.test.mjs`, add to the allowed `routes` table after `['POST', '/api/devices/query', 'api'],`:

```js
      ['POST', '/api/devices/selection', 'api'],
      ['POST', '/api/devices/selection/ops', 'api'],
      ['POST', '/api/devices/selection/resolve', 'api'],
```

Add to the denied table after `['POST', '/api/devices/synthetic-device-1', 405],`:

```js
      ['POST', '/api/devices/selection/other', 404],
      ['GET', '/api/devices/selection/ops', 405],
```

- [ ] **Step 2: Write the failing API check**

In `api-e2e/devices-api.mjs`, add `import { randomUUID } from 'node:crypto';` after the `node:assert/strict` import. Insert after the OrgUnit query assertion that expects 150, before `const detail = ...`:

```js
const select = async (path, data) => {
  const response = await api.post(`${root}/selection${path}`, {
    headers,
    data,
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
};
const tab = { gridId: 'devices', tabId: randomUUID() };
const hs04 = [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }];
assert.equal((await select('', tab)).selection.selectedCount, 0);
assert.equal(
  (
    await api.post(`${root}/selection/ops`, {
      data: { ...tab, ops: [{ op: 'deselectAll' }] },
    })
  ).status(),
  403,
);
assert.deepEqual(
  (
    await select('/ops', {
      ...tab,
      ops: [{ op: 'selectAll', predicates: hs04 }],
    })
  ).selection,
  {
    terms: [{ type: 'all', predicates: hs04 }],
    added: 0,
    excluded: 0,
    selectedCount: 96,
  },
);
const changed = await select('/ops', {
  ...tab,
  ops: [
    { op: 'deselect', ids: ['synthetic-device-1'] },
    { op: 'select', ids: ['synthetic-device-0'] },
  ],
});
assert.equal(changed.selection.selectedCount, 96);
assert.deepEqual(
  (
    await select('/resolve', {
      ...tab,
      rowIds: [
        'synthetic-device-0',
        'synthetic-device-1',
        'synthetic-device-2',
      ],
      groupRoutes: [],
    })
  ).selected,
  {
    'synthetic-device-0': true,
    'synthetic-device-1': false,
    'synthetic-device-2': true,
  },
);
// HS-04 holds 29 Replace soon devices. Device 1 is one of them and is deselected.
assert.equal(
  (
    await query({
      selection: tab,
      predicates: [
        { field: 'battery', operator: 'is', values: ['replace-soon'] },
      ],
    })
  ).matching,
  28,
);
assert.equal(
  (await select('', { gridId: 'devices', tabId: randomUUID() })).selection
    .selectedCount,
  0,
);
assert.equal(
  (await select('/ops', { ...tab, ops: [{ op: 'deselectAll' }] })).selection
    .selectedCount,
  0,
);
```

Add this line to the returned list after the filter line:

```js
      'device selection keeps Select All terms, row exceptions, and per-tab isolation: pass',
```

- [ ] **Step 3: Run the edge test to verify it fails**

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: FAIL with `POST /api/devices/selection` returning 404.

- [ ] **Step 4: Allow the routes at the edge**

In `deployment/bootstrap/application-edge.mjs`, replace `deviceWrite` with:

```js
const deviceWrite =
  /^\/api\/devices\/(?:sync|query|selection(?:\/(?:ops|resolve))?)$/;
```

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Add the compare-and-set write**

In `api/src/app/cache/cache.service.ts`, add after `replace`:

```ts
  /** Write only if the value still equals `expected`. A null `expected` requires an absent key. */
  async swap(
    key: string,
    expected: string | null,
    value: string,
    seconds: number,
  ): Promise<boolean> {
    const result = await this.execute((client) =>
      client.eval(
        "local current=redis.call('GET',KEYS[1]); if (ARGV[1]=='absent' and current==false) or (ARGV[1]=='equal' and current==ARGV[2]) then redis.call('SET',KEYS[1],ARGV[3],'EX',tonumber(ARGV[4])); return 1 end return 0",
        {
          keys: [key],
          arguments: [
            expected === null ? 'absent' : 'equal',
            expected ?? '',
            value,
            String(seconds),
          ],
        },
      ),
    );
    return result === 1;
  }
```

- [ ] **Step 6: Add the service methods**

In `api/src/app/devices/devices.module.ts`, import `CacheModule` from `../cache/cache.module` and add it to `imports`.

In `api/src/app/devices/devices.service.ts`:

1. Add the imports:

```ts
import { CacheService } from '../cache/cache.service';
import {
  SelectionBusyError,
  SelectionTooLargeError,
  applySelectionOps,
  changeSelection,
  emptySelection,
  parseSelection,
  selectionSpec,
  selectionStorageKey,
  type SelectionState,
} from './device-selection';
```

2. Add `matchingAmongSql`, `selectedAmongSql`, and `selectionCountSql` to the import from `./device-query`. Add `type DevicePredicate`, `type DeviceSelectionKey`, `type DeviceSelectionOp`, and `type DeviceSelectionSpec` to the import from `@campus/application-contracts`.
3. Add `private readonly cache: CacheService,` to the constructor.
4. In `page`, replace `const sql = devicePageSql(customerId, query);` with:

```ts
const selection = query.selection
  ? await this.storedSelection(session, query.selection)
  : null;
const sql = devicePageSql(customerId, query, selection);
```

5. Append these methods to the class:

```ts
  private async storedSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
  ): Promise<SelectionState> {
    return parseSelection(
      await this.cache.get(selectionStorageKey(session.identity.id, key)),
    );
  }

  private async selectedCount(
    client: PoolClient,
    customerId: string,
    state: SelectionState,
  ): Promise<number> {
    const sql = selectionCountSql(customerId, state);
    return (await client.query(sql.text, sql.values)).rows[0]?.['selected'] ?? 0;
  }

  private async deviceIds(client: PoolClient, sql: { text: string; values: unknown[] }) {
    return (await client.query(sql.text, sql.values)).rows.map((row) =>
      String(row['device_id']),
    );
  }

  async selection(
    session: SessionResponse,
    key: DeviceSelectionKey,
  ): Promise<DeviceSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = await this.storedSelection(session, key);
        return selectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
        );
      },
      selectionSpec(emptySelection(), 0),
    );
  }

  async changeSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    ops: DeviceSelectionOp[],
  ): Promise<DeviceSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const matching = (predicates: DevicePredicate[], ids: string[]) =>
          this.deviceIds(client, matchingAmongSql(customerId, predicates, ids));
        let state: SelectionState;
        try {
          state = await changeSelection(
            this.cache,
            selectionStorageKey(session.identity.id, key),
            (current) => applySelectionOps(current, ops, matching),
          );
        } catch (error) {
          if (error instanceof SelectionTooLargeError)
            throw new ConflictException({ reason: 'selection-too-large' });
          if (error instanceof SelectionBusyError)
            throw new ConflictException({ reason: 'selection-busy' });
          throw error;
        }
        return selectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
        );
      },
      selectionSpec(emptySelection(), 0),
    );
  }

  /** Grouped rows wait for server-side grouping. Their routes resolve as unselected. */
  async resolveSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    rowIds: string[],
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
        return Object.fromEntries(rowIds.map((id) => [id, chosen.has(id)]));
      },
      {},
    );
  }
```

- [ ] **Step 7: Add the controller routes**

In `api/src/app/devices/devices.controller.ts`, add `deviceSelectionChangeSchema`, `deviceSelectionKeySchema`, and `deviceSelectionResolveSchema` to the import from `@campus/application-contracts`. Add these methods before `@Get('org-units')`:

```ts
  @Post('selection')
  @HttpCode(200)
  async selection(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const key = deviceSelectionKeySchema.parse(body);
    await this.current(request);
    return { selection: await this.devices.selection(request.session, key) };
  }

  @Post('selection/ops')
  @HttpCode(200)
  async changeSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = deviceSelectionChangeSchema.parse(body);
    await this.current(request);
    return {
      selection: await this.devices.changeSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.ops,
      ),
    };
  }

  @Post('selection/resolve')
  @HttpCode(200)
  async resolveSelection(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = deviceSelectionResolveSchema.parse(body);
    await this.current(request);
    return {
      selected: await this.devices.resolveSelection(
        request.session,
        { gridId: input.gridId, tabId: input.tabId },
        input.rowIds,
      ),
    };
  }
```

- [ ] **Step 8: Run the checks**

Run: `npm exec -- nx run-many -t test build -p api --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache > .superpowers/sdd/2026-10-05-device-grid-features/task3-e2e.log 2>&1; tail -40 .superpowers/sdd/2026-10-05-device-grid-features/task3-e2e.log`
Expected: PASS, including the new selection line. The browser check still passes because the frontend has not changed since Task 1.

- [ ] **Step 9: Commit**

```bash
git add api/src/app deployment/bootstrap api-e2e/devices-api.mjs
git commit -m "feat: keep device selections per tab through the API"
```

---

### Task 4: LibreGrid packages, filter model mapping, and column filters

**Files:**

- Modify: `package.json`, `package-lock.json`
- Create: `frontend/src/app/devices/device-filter-model.ts`
- Create: `frontend/src/app/devices/device-filter-model.spec.ts`
- Modify: `frontend/src/app/devices/device-columns.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`

**Interfaces:**

- Consumes: the Task 1 predicates.
- Produces: in `device-filter-model.ts`:
  - `predicatesFromFilterModel(model: FilterModel | null | undefined): DevicePredicate[]`. The result is in column order. It throws for a model the query cannot express.
  - `filterModelFromPredicates(predicates): FilterModel`. The last predicate for a field wins.
  - `canonicalPredicates(predicates): DevicePredicate[]`.
  - `samePredicates(a, b): boolean`.
  - `filterModelUpdate(current, predicates): FilterModel | null`. It returns `null` when the grid already shows the predicates.
  - `orgUnitTreePath(path): string[]`.
- Produces: `deviceColumnDefs(onDetails, options?: { orgUnits?: () => readonly string[]; now?: () => number })`. Every data column has a filter for its field kind. The details column has no filter and stays out of the tool panels.
- Produces: `detailsKeyHandler` opens details on Enter only. Space stays with row selection.

- [ ] **Step 1: Install the packages**

Run:

```bash
npm install --save-exact @libregrid/server-side-row-model@1.3.5 @libregrid/server-side-selection@1.3.5 @libregrid/menu@1.3.5 @libregrid/side-bar@1.3.5 @libregrid/columns-tool-panel@1.3.5 @libregrid/filters-tool-panel@1.3.5 @libregrid/set-filter@1.3.5 @libregrid/status-bar@1.3.5
```

Expected: `package.json` lists the eight packages at exactly `1.3.5`. `npm ls ag-grid-community` shows only `36.2.0`.

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/app/devices/device-filter-model.spec.ts`:

```ts
import type { DevicePredicate } from '@campus/application-contracts';
import {
  canonicalPredicates,
  filterModelFromPredicates,
  filterModelUpdate,
  orgUnitTreePath,
  predicatesFromFilterModel,
} from './device-filter-model';

const day = new Date(2026, 9, 1).toISOString();
const predicates: DevicePredicate[] = [
  { field: 'serialNumber', operator: 'equals', value: 'C0A1-0001' },
  { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
  { field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] },
  { field: 'lastContact', operator: 'after', value: day },
  { field: 'notes', operator: 'isEmpty' },
];

it('round-trips every filter type through the grid filter model', () => {
  const model = filterModelFromPredicates(predicates);
  expect(model['assetTag']).toEqual({
    filterType: 'text',
    type: 'startsWith',
    filter: 'HS-04',
  });
  expect(model['notes']).toEqual({ filterType: 'text', type: 'blank' });
  expect(model['battery']).toEqual({
    filterType: 'set',
    values: ['replace-soon', 'no-report'],
  });
  expect(model['lastContact']).toEqual({
    filterType: 'date',
    type: 'after',
    dateFrom: '2026-10-01 00:00:00',
    dateTo: null,
  });
  expect(predicatesFromFilterModel(model)).toEqual(predicates);
});

it('orders predicates by column and keeps one filter per field', () => {
  expect(
    canonicalPredicates([
      { field: 'notes', operator: 'isEmpty' },
      { field: 'model', operator: 'contains', value: 'Lenovo' },
      { field: 'model', operator: 'contains', value: 'Dell' },
    ]),
  ).toEqual([
    { field: 'model', operator: 'contains', value: 'Dell' },
    { field: 'notes', operator: 'isEmpty' },
  ]);
});

it('treats an empty model as no filters and an empty set as no matches', () => {
  expect(predicatesFromFilterModel(null)).toEqual([]);
  expect(predicatesFromFilterModel({})).toEqual([]);
  expect(
    predicatesFromFilterModel({ battery: { filterType: 'set', values: [] } }),
  ).toEqual([{ field: 'battery', operator: 'is', values: [] }]);
});

it('refuses filters the device query cannot express', () => {
  const text = (type: string, filter: string) => ({
    model: { filterType: 'text', type, filter },
  });
  expect(() =>
    predicatesFromFilterModel({
      details: { filterType: 'text', type: 'contains', filter: 'x' },
    }),
  ).toThrow();
  expect(() => predicatesFromFilterModel(text('notContains', 'x'))).toThrow();
  expect(() =>
    predicatesFromFilterModel(text('contains', 'x'.repeat(257))),
  ).toThrow();
});

it('updates the grid only when the chips differ from its filters', () => {
  const chips: DevicePredicate[] = [{ field: 'notes', operator: 'isEmpty' }];
  const model = filterModelFromPredicates(chips);
  expect(filterModelUpdate(model, chips)).toBeNull();
  expect(filterModelUpdate({}, chips)).toEqual(model);
  expect(filterModelUpdate(model, [])).toEqual({});
});

it('places organization units under the root of the filter tree', () => {
  expect(orgUnitTreePath('/')).toEqual(['/']);
  expect(orgUnitTreePath('/School A/Library')).toEqual([
    '/',
    'School A',
    'Library',
  ]);
});
```

In `frontend/src/app/devices/device-grid.spec.ts`, change the first test's call to:

```ts
const columns = deviceColumnDefs(() => undefined, {
  now: () => Date.parse('2026-10-05T12:00:00Z'),
});
```

Replace the test `opens details with Enter or Space on the details cell` with:

```ts
it('opens details with Enter and leaves Space to row selection', () => {
  const onDetails = vi.fn();
  const handler = detailsKeyHandler(onDetails);
  const press = (colId: string, key: string) =>
    handler({
      column: { getColId: () => colId },
      data: row,
      rowIndex: 3,
      event: new KeyboardEvent('keydown', { key }),
    } as unknown as CellKeyDownEvent<DeviceRow>);
  press('details', 'Enter');
  press('details', ' ');
  press('serialNumber', 'Enter');
  expect(onDetails.mock.calls).toEqual([[row, 3]]);
});
```

Append:

```ts
it('gives each data column the filter of its field type', () => {
  const columns = deviceColumnDefs(() => undefined, {
    orgUnits: () => ['/', '/School A'],
  });
  const column = (id: string) =>
    columns.find((candidate) => candidate.colId === id)!;
  expect(column('details').filter).toBe(false);
  expect(column('assetTag').filter).toBe('agTextColumnFilter');
  expect(column('assetTag').filterParams.filterOptions).toEqual([
    'contains',
    'startsWith',
    'equals',
    'blank',
  ]);
  expect(
    column('lastContact').filterParams.filterOptions.map(
      (option: { displayKey: string }) => option.displayKey,
    ),
  ).toEqual(['before', 'after']);
  expect(column('battery').filter).toBe('agSetColumnFilter');
  expect(column('battery').filterParams.values).toEqual([
    'normal',
    'replace-soon',
    'replace-now',
    'no-report',
    'unavailable',
  ]);
  expect(
    column('battery').filterParams.valueFormatter({ value: 'no-report' }),
  ).toBe('No battery report');
  const units: string[][] = [];
  column('orgUnitPath').filterParams.values({
    success: (values: string[]) => units.push(values),
  });
  expect(units).toEqual([['/', '/School A']]);
  expect(
    column('orgUnitPath').filterParams.treeListPathGetter('/School A'),
  ).toEqual(['/', 'School A']);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `./device-filter-model` does not exist, and `deviceColumnDefs` does not accept an options object.

- [ ] **Step 4: Write the mapping**

Create `frontend/src/app/devices/device-filter-model.ts`:

```ts
import type { FilterModel } from 'ag-grid-community';
import { z } from 'zod';
import {
  devicePredicateSchema,
  type DevicePredicate,
} from '@campus/application-contracts';
import {
  DEVICE_FIELDS,
  dateInputToIso,
  dateInputValue,
  type DeviceField,
} from './device-fields';

const textModel = z.object({
  filterType: z.literal('text'),
  type: z.enum(['contains', 'startsWith', 'equals', 'blank']),
  filter: z.string().nullish(),
});
const dateModel = z.object({
  filterType: z.literal('date'),
  type: z.enum(['before', 'after']),
  dateFrom: z.string(),
});
const setModel = z.object({
  filterType: z.literal('set'),
  values: z.array(z.string()),
});

function predicateFor(field: DeviceField, model: unknown): unknown {
  if (field.kind === 'text') {
    const text = textModel.parse(model);
    return text.type === 'blank'
      ? { field: field.id, operator: 'isEmpty' }
      : { field: field.id, operator: text.type, value: text.filter ?? '' };
  }
  if (field.kind === 'date') {
    const date = dateModel.parse(model);
    return {
      field: field.id,
      operator: date.type,
      value: dateInputToIso(date.dateFrom.slice(0, 10)),
    };
  }
  const set = setModel.parse(model);
  return {
    field: field.id,
    operator: field.kind === 'battery' ? 'is' : 'in',
    values: set.values,
  };
}

/**
 * Translate the grid's column filters to device predicates in column order.
 * A model that the device query cannot express throws. The grid then shows a failed load instead of unfiltered rows.
 */
export function predicatesFromFilterModel(
  model: FilterModel | null | undefined,
): DevicePredicate[] {
  const entries: FilterModel = model ?? {};
  for (const key of Object.keys(entries))
    if (!DEVICE_FIELDS.some((field) => field.id === key))
      throw new Error(`The device query has no filter for ${key}.`);
  return DEVICE_FIELDS.flatMap((field) =>
    entries[field.id]
      ? [devicePredicateSchema.parse(predicateFor(field, entries[field.id]))]
      : [],
  );
}

export function filterModelFromPredicates(
  predicates: readonly DevicePredicate[],
): FilterModel {
  const model: FilterModel = {};
  for (const predicate of predicates) {
    if (predicate.field === 'battery' || predicate.field === 'orgUnitPath')
      model[predicate.field] = {
        filterType: 'set',
        values: [...predicate.values],
      };
    else if (predicate.field === 'lastContact')
      model[predicate.field] = {
        filterType: 'date',
        type: predicate.operator,
        dateFrom: `${dateInputValue(predicate.value)} 00:00:00`,
        dateTo: null,
      };
    else if (predicate.operator === 'isEmpty')
      model[predicate.field] = { filterType: 'text', type: 'blank' };
    else
      model[predicate.field] = {
        filterType: 'text',
        type: predicate.operator,
        filter: predicate.value,
      };
  }
  return model;
}

/** The form that the grid and the chips agree on: column order, one filter per field. */
export function canonicalPredicates(
  predicates: readonly DevicePredicate[],
): DevicePredicate[] {
  return predicatesFromFilterModel(filterModelFromPredicates(predicates));
}

export function samePredicates(
  a: readonly DevicePredicate[],
  b: readonly DevicePredicate[],
): boolean {
  return (
    JSON.stringify(canonicalPredicates(a)) ===
    JSON.stringify(canonicalPredicates(b))
  );
}

/** The model to give the grid for these predicates, or null when the grid already shows them. */
export function filterModelUpdate(
  current: FilterModel | null,
  predicates: readonly DevicePredicate[],
): FilterModel | null {
  let shown: DevicePredicate[] | null;
  try {
    shown = predicatesFromFilterModel(current);
  } catch {
    shown = null;
  }
  return shown && samePredicates(shown, predicates)
    ? null
    : filterModelFromPredicates(predicates);
}

/** The OrgUnit set filter shows each path under the root of a tree. */
export function orgUnitTreePath(path: string): string[] {
  return ['/', ...path.split('/').filter(Boolean)];
}
```

- [ ] **Step 5: Add the column filters**

In `frontend/src/app/devices/device-columns.ts`:

1. Add `IFilterOptionDef` to the `ag-grid-community` type import. Add `BATTERY_LABELS` and `type DeviceField` to the `./device-fields` import. Add `import { orgUnitTreePath } from './device-filter-model';`.
2. Add before `deviceColumnDefs`:

```ts
const filterButtons = { buttons: ['apply', 'reset'], closeOnApply: true };
/** The device query applies these filters. Rows the grid holds already match. */
const serverSide = () => true;
const dateOptions: IFilterOptionDef[] = [
  {
    displayKey: 'before',
    displayName: 'Before',
    predicate: serverSide,
    numberOfInputs: 1,
  },
  {
    displayKey: 'after',
    displayName: 'On or after',
    predicate: serverSide,
    numberOfInputs: 1,
  },
];

function columnFilter(
  field: DeviceField,
  orgUnits: () => readonly string[],
): Pick<ColDef<DeviceRow>, 'filter' | 'filterParams'> {
  switch (field.kind) {
    case 'text':
      return {
        filter: 'agTextColumnFilter',
        filterParams: {
          filterOptions: ['contains', 'startsWith', 'equals', 'blank'],
          maxNumConditions: 1,
          trimInput: true,
          ...filterButtons,
        },
      };
    case 'date':
      return {
        filter: 'agDateColumnFilter',
        filterParams: {
          filterOptions: dateOptions,
          maxNumConditions: 1,
          ...filterButtons,
        },
      };
    case 'battery':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: Object.keys(BATTERY_LABELS),
          valueFormatter: ({ value }: { value: BatteryFilterValue }) =>
            BATTERY_LABELS[value],
          ...filterButtons,
        },
      };
    case 'orgUnit':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: (params: { success: (values: string[]) => void }) =>
            params.success([...orgUnits()]),
          refreshValuesOnOpen: true,
          treeList: true,
          treeListPathGetter: orgUnitTreePath,
          treeListFormatter: (key: string | null, level: number) =>
            level === 0 ? 'All organization units' : (key ?? ''),
          ...filterButtons,
        },
      };
  }
}
```

Add `type BatteryFilterValue` to the `./device-fields` import as well.

3. Change the `deviceColumnDefs` signature and use the options:

```ts
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, index: number) => void,
  options: {
    orgUnits?: () => readonly string[];
    now?: () => number;
  } = {},
): ColDef<DeviceRow>[] {
  const now = options.now ?? Date.now;
  const orgUnits = options.orgUnits ?? (() => []);
```

4. Add these members to the details column:

```ts
      filter: false,
      suppressHeaderMenuButton: true,
      suppressColumnsToolPanel: true,
      suppressFiltersToolPanel: true,
```

5. Add `...columnFilter(field, orgUnits),` to each data column after `sortable: true,`.
6. Change `detailsKeyHandler`. Its comment becomes `/** Enter on a focused details cell opens the device. Space toggles row selection (UI-09). */`. Its key check becomes:

```ts
if (keyboard?.key !== 'Enter') return;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run frontend:lint --skip-nx-cache`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json frontend/src/app/devices
git commit -m "feat: map device column filters to the device query"
```

---

### Task 5: Device selection provider

**Files:**

- Create: `frontend/src/app/devices/device-selection.ts`
- Create: `frontend/src/app/devices/device-selection.spec.ts`

**Interfaces:**

- Consumes: the Task 2 contracts and Task 4 `predicatesFromFilterModel` and `filterModelFromPredicates`.
- Produces:
  - `DEVICE_GRID_ID = 'devices'`.
  - `deviceSelectionTab(storage?): string`.
  - `class DeviceSelectionProvider implements ServerSideSelectionProvider`. Its constructor takes `call: (path: string, body: unknown) => Promise<Response | null>`. It has a `spec: WritableSignal<DeviceSelectionSpec | null>` signal.
  - `selectionScope(spec: DeviceSelectionSpec | null): string`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/app/devices/device-selection.spec.ts`:

```ts
import { vi } from 'vitest';
import type { DeviceSelectionSpec } from '@campus/application-contracts';
import {
  DeviceSelectionProvider,
  deviceSelectionTab,
  selectionScope,
} from './device-selection';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const spec: DeviceSelectionSpec = {
  terms: [
    {
      type: 'all',
      predicates: [
        { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
      ],
    },
  ],
  added: 0,
  excluded: 1,
  selectedCount: 95,
};

it('sends Select All with the grid filters as device predicates', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [
      {
        op: 'selectAll',
        filter: {
          assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
        },
      },
      { op: 'deselect', ids: ['d1'] },
    ],
  });
  expect(call).toHaveBeenCalledWith('/api/devices/selection/ops', {
    gridId: 'devices',
    tabId,
    ops: [
      { op: 'selectAll', predicates: spec.terms[0].predicates },
      { op: 'deselect', ids: ['d1'] },
    ],
  });
  expect(provider.spec()?.selectedCount).toBe(95);
});

it('reports the selection in the grid filter form', async () => {
  const provider = new DeviceSelectionProvider(
    vi.fn().mockResolvedValue(Response.json({ selection: spec })),
  );
  expect(await provider.getSpec({ gridId: 'devices', tabId })).toEqual({
    terms: [
      {
        type: 'all',
        filter: {
          assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
        },
      },
    ],
    selectedCount: 95,
  });
});

it('resolves loaded rows and fails when the API is unreachable', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ selected: { d1: true, d2: false } }))
    .mockResolvedValueOnce(null);
  const provider = new DeviceSelectionProvider(call);
  expect(
    await provider.resolveSelected({
      gridId: 'devices',
      tabId,
      rowIds: ['d1', 'd2'],
      groupRoutes: [],
    }),
  ).toEqual({ d1: true, d2: false });
  await expect(provider.getSpec({ gridId: 'devices', tabId })).rejects.toThrow(
    'The device selection is unavailable.',
  );
});

it('splits large row batches to the API limit', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call);
  const ids = Array.from({ length: 2500 }, (_, index) => `d${index}`);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [{ op: 'select', ids }],
  });
  expect(
    call.mock.calls[0][1].ops.map((op: { ids: string[] }) => op.ids.length),
  ).toEqual([2000, 500]);
});

it('keeps one selection tab per browser tab', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
  };
  const first = deviceSelectionTab(storage);
  expect(deviceSelectionTab(storage)).toBe(first);
  const blocked = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: () => undefined,
  };
  expect(deviceSelectionTab(blocked)).toMatch(/^[0-9a-f-]{36}$/);
});

it('describes what Select All captured', () => {
  expect(selectionScope(null)).toBe('');
  expect(selectionScope(spec)).toBe(
    'Selected by filter: Asset tag starts with: HS-04 · 1 excluded',
  );
  expect(
    selectionScope({
      terms: [{ type: 'all', predicates: [] }],
      added: 2,
      excluded: 0,
      selectedCount: 450,
    }),
  ).toBe('Selected by filter: All devices · 2 added');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `./device-selection` does not exist.

- [ ] **Step 3: Write the provider**

Create `frontend/src/app/devices/device-selection.ts`:

```ts
import { signal } from '@angular/core';
import { z } from 'zod';
import type {
  SelectionOp,
  SelectionSpec,
  ServerSideSelectionProvider,
} from '@libregrid/server-side-selection';
import {
  deviceSelectionKeySchema,
  deviceSelectionSpecSchema,
  type DeviceSelectionKey,
  type DeviceSelectionOp,
  type DeviceSelectionSpec,
} from '@campus/application-contracts';
import { chipLabel } from './device-fields';
import {
  filterModelFromPredicates,
  predicatesFromFilterModel,
} from './device-filter-model';

export const DEVICE_GRID_ID = 'devices' as const;
const tabStorageKey = 'cc.devices.selection-tab';
const idBatch = 2000;
const opBatch = 100;

function browserSession(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Each browser tab keeps its own selection. A reload in the same tab keeps it. */
export function deviceSelectionTab(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserSession(),
): string {
  try {
    const saved = storage?.getItem(tabStorageKey);
    if (saved && z.uuid().safeParse(saved).success) return saved;
    const created = crypto.randomUUID();
    storage?.setItem(tabStorageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function key(params: { gridId: string; tabId: string }): DeviceSelectionKey {
  return deviceSelectionKeySchema.parse({
    gridId: params.gridId,
    tabId: params.tabId,
  });
}

function deviceOps(op: SelectionOp): DeviceSelectionOp[] {
  switch (op.op) {
    case 'selectAll':
      return [
        { op: 'selectAll', predicates: predicatesFromFilterModel(op.filter) },
      ];
    case 'deselectAll':
      return [{ op: 'deselectAll' }];
    case 'select':
    case 'deselect': {
      const batches: DeviceSelectionOp[] = [];
      for (let start = 0; start < op.ids.length; start += idBatch)
        batches.push({ op: op.op, ids: op.ids.slice(start, start + idBatch) });
      return batches;
    }
    default:
      throw new Error('Grouped selection is not available for devices.');
  }
}

/** The LibreGrid selection provider for the device grid. The API keeps the selection. */
export class DeviceSelectionProvider implements ServerSideSelectionProvider {
  /** The latest selection that the API reported, for the status bar. */
  readonly spec = signal<DeviceSelectionSpec | null>(null);

  constructor(
    private readonly call: (
      path: string,
      body: unknown,
    ) => Promise<Response | null>,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.call(`/api/devices/selection${path}`, body);
    if (!response?.ok) throw new Error('The device selection is unavailable.');
    return response.json();
  }

  private keep(body: unknown): DeviceSelectionSpec {
    const spec = deviceSelectionSpecSchema.parse(
      (body as { selection?: unknown }).selection,
    );
    this.spec.set(spec);
    return spec;
  }

  async getSpec(params: {
    gridId: string;
    tabId: string;
  }): Promise<SelectionSpec> {
    const spec = this.keep(await this.post('', key(params)));
    return {
      terms: spec.terms.map((term) => ({
        type: 'all' as const,
        filter: filterModelFromPredicates(term.predicates),
      })),
      selectedCount: spec.selectedCount,
    };
  }

  async applyOps(params: {
    gridId: string;
    tabId: string;
    ops: SelectionOp[];
  }): Promise<void> {
    const ops = params.ops.flatMap(deviceOps);
    for (let start = 0; start < ops.length; start += opBatch)
      this.keep(
        await this.post('/ops', {
          ...key(params),
          ops: ops.slice(start, start + opBatch),
        }),
      );
  }

  async resolveSelected(params: {
    gridId: string;
    tabId: string;
    rowIds: string[];
    groupRoutes: string[];
  }): Promise<Record<string, boolean>> {
    const selected: Record<string, boolean> = {};
    for (let start = 0; start < params.rowIds.length; start += idBatch) {
      const body = await this.post('/resolve', {
        ...key(params),
        rowIds: params.rowIds.slice(start, start + idBatch),
        groupRoutes: [],
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
}

/** What Select All captured, with explicit changes (SELECT-01). */
export function selectionScope(spec: DeviceSelectionSpec | null): string {
  if (!spec?.terms.length) return '';
  const terms = spec.terms
    .map((term) =>
      term.predicates.length
        ? term.predicates.map(chipLabel).join(' and ')
        : 'All devices',
    )
    .join('; ');
  return [
    `Selected by filter: ${terms}`,
    ...(spec.added ? [`${spec.added} added`] : []),
    ...(spec.excluded ? [`${spec.excluded} excluded`] : []),
  ].join(' · ');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run frontend:lint --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: provide device selections to LibreGrid"
```

---

### Task 6: Grid filters drive the query, and grid state survives details

**Files:**

- Modify: `frontend/src/app/devices/device-datasource.ts`
- Modify: `frontend/src/app/devices/device-grid.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`
- Modify: `frontend/src/app/devices/devices.store.ts`
- Modify: `frontend/src/app/devices/devices.store.spec.ts`
- Modify: `frontend/src/app/devices/devices.ts`
- Modify: `frontend/src/app/devices/devices.html`
- Modify: `frontend/src/app/devices/devices.spec.ts`

**Interfaces:**

- Consumes: the Task 4 mapping and the Task 5 provider.
- Produces: in `device-datasource.ts`:
  - `interface DeviceView { predicates: DevicePredicate[]; sort: DeviceSort; selection: DeviceSelectionKey | null }`.
  - `type DeviceLoader = (offset: number, limit: number, view: DeviceView) => Promise<DevicePage | null>`.
  - `defaultGridState(): GridState` and `savedGridState(state: GridState): GridState`.
  - `deviceDatasource(load, onLoaded?)`. `initialSortState` is removed.
- Produces: in `DevicesStore`:
  - `view: WritableSignal<DeviceView>`, `setView(view)`, and `gridState: WritableSignal<GridState | null>`.
  - `selection: DeviceSelectionProvider` and `selectionTab: string`.
  - `setPredicates` no longer changes `revision`. `sort` and `setSort` are removed.
- Produces: `DeviceGrid` inputs and outputs:
  - Inputs `state: GridState | null`, `saveState: (state: GridState) => void`, `predicates: DevicePredicate[]`, and `orgUnits: readonly DeviceOrgUnit[]`.
  - Output `filtersChange: DevicePredicate[]`.
  - The `sort` input is removed.

The chips and the column filters now share the grid filter model. Revision bumps only reload after a refresh or a reconnect. The grid reloads itself when its filters change.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/app/devices/device-grid.spec.ts`, replace the import from `./device-datasource` with:

```ts
import {
  defaultGridState,
  deviceDatasource,
  savedGridState,
  sortFromModel,
} from './device-datasource';
```

Replace the test `loads grid blocks from the device query with the header sort` with:

```ts
it('loads grid blocks with the column filters and the header sort', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [row],
    matching: 96,
    total: 450,
    observedAt: null,
  });
  const success = vi.fn();
  const fail = vi.fn();
  deviceDatasource(load).getRows({
    request: {
      startRow: 100,
      endRow: 200,
      sortModel: [{ colId: 'assetTag', sort: 'desc' }],
      filterModel: {
        assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
      },
    },
    success,
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(load).toHaveBeenCalledWith(100, 100, {
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    selection: null,
  });
  expect(success).toHaveBeenCalledWith({ rowData: [row], rowCount: 96 });
  expect(fail).not.toHaveBeenCalled();
});

it('fails the block for a filter the device query cannot express', () => {
  const load = vi.fn();
  const fail = vi.fn();
  deviceDatasource(load).getRows({
    request: {
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {
        model: { filterType: 'text', type: 'notContains', filter: 'x' },
      },
    },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  expect(fail).toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});
```

Replace the test `starts the grid with the stored sort` with:

```ts
it('starts in serial order and saves grid state without row selection', () => {
  expect(defaultGridState()).toEqual({
    sort: { sortModel: [{ colId: 'serialNumber', sort: 'asc' }] },
  });
  const sort = { sortModel: [{ colId: 'assetTag', sort: 'desc' as const }] };
  const filter = {
    filterModel: { notes: { filterType: 'text', type: 'blank' } },
  };
  expect(
    savedGridState({
      sort,
      filter,
      rowSelection: ['d1'],
      pagination: { page: 2, pageSize: 100 },
    }),
  ).toEqual({ sort, filter, pagination: { page: 2, pageSize: 100 } });
});
```

In `frontend/src/app/devices/devices.store.spec.ts`, make these changes:

1. In `queries rows with the active filters and sort and keeps the counts`, replace the `setPredicates` and `setSort` calls with:

```ts
store.setView({
  predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
  sort: { field: 'assetTag', direction: 'desc' },
  selection: null,
});
```

Add `selection: null,` after `limit: 100,` in the expected request body.

2. Replace the test `changing filters reloads the grid and forgets the row position` with:

```ts
it('changing filters forgets the row position and leaves reloads to the grid', () => {
  const store = setup(vi.fn());
  store.position.set({ index: 4, deviceId: 'd4' });
  const before = store.revision();
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.revision()).toBe(before);
  expect(store.position()).toBeNull();
  store.position.set({ index: 4, deviceId: 'd4' });
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.position()).toEqual({ index: 4, deviceId: 'd4' });
});

it('a different grid query forgets the opened row and the same query keeps it', () => {
  const store = setup(vi.fn());
  const view = {
    predicates: [],
    sort: { field: 'serialNumber' as const, direction: 'asc' as const },
    selection: null,
  };
  store.position.set({ index: 4, deviceId: 'd4' });
  store.setView({ ...view });
  expect(store.position()).not.toBeNull();
  store.setView({
    ...view,
    selection: { gridId: 'devices', tabId: store.selectionTab },
  });
  expect(store.position()).toBeNull();
});

it('sends selection requests through the signed-in connection', async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      selection: { terms: [], added: 0, excluded: 0, selectedCount: 0 },
    }),
  );
  const store = setup(request);
  await store.selection.getSpec({
    gridId: 'devices',
    tabId: store.selectionTab,
  });
  expect(request).toHaveBeenCalledWith('/api/devices/selection', {
    gridId: 'devices',
    tabId: store.selectionTab,
  });
});
```

3. In `ignores counts from a query whose filters changed meanwhile`, replace `store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);` with:

```ts
store.setView({
  predicates: [{ field: 'notes', operator: 'isEmpty' }],
  sort: { field: 'serialNumber', direction: 'asc' },
  selection: null,
});
```

4. In `clears browsing state when a different person signs in`, add `store.gridState.set({ pagination: { page: 3, pageSize: 100 } });` before the session change. Add these assertions at the end:

```ts
expect(store.gridState()).toBeNull();
expect(store.view().predicates).toEqual([]);
```

In `frontend/src/app/devices/devices.spec.ts`:

1. Add `import { By } from '@angular/platform-browser';` and `import { DeviceFilter } from './device-filter';`.
2. Change `GridStub` to:

```ts
class GridStub {
  readonly load = input<unknown>();
  readonly revision = input(0);
  readonly optionalColumns = input<unknown>();
  readonly focusIndex = input<number | null>(null);
  readonly state = input<unknown>();
  readonly saveState = input<unknown>();
  readonly predicates = input<unknown>();
  readonly orgUnits = input<unknown>();
  readonly details = output<unknown>();
  readonly rangeChange = output<unknown>();
  readonly filtersChange = output<unknown>();
}
```

3. In the fake store, remove `sort` and `setSort`. Add:

```ts
    view: signal({
      predicates: options.predicates ?? [],
      sort: { field: 'serialNumber', direction: 'asc' },
      selection: null as unknown,
    }),
    gridState: signal(null),
    setView: vi.fn(),
```

4. Append:

```ts
it('replaces the filter of a field that already has one', () => {
  const { store, fixture } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const filter = fixture.debugElement.query(By.directive(DeviceFilter))
    .componentInstance as DeviceFilter;
  filter.applied.emit({ field: 'model', operator: 'contains', value: 'Dell' });
  expect(store.setPredicates).toHaveBeenCalledWith([
    twoChips[0],
    { field: 'model', operator: 'contains', value: 'Dell' },
  ]);
});

it('takes filters from the grid column filters', () => {
  const { store, fixture } = setup({
    sync: ready(),
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  grid.filtersChange.emit([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.setPredicates).toHaveBeenCalledWith([
    { field: 'notes', operator: 'isEmpty' },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `defaultGridState` is not exported, `setView` does not exist, and the page does not pass `filtersChange` to the store.

- [ ] **Step 3: Change the datasource**

In `frontend/src/app/devices/device-datasource.ts`:

1. Change the imports to:

```ts
import type {
  FilterModel,
  GridState,
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import type {
  DevicePage,
  DevicePredicate,
  DeviceQuery,
  DeviceRow,
  DeviceSelectionKey,
} from '@campus/application-contracts';
import { DEVICE_FIELDS } from './device-fields';
import { predicatesFromFilterModel } from './device-filter-model';
```

2. Replace `DeviceLoader` with:

```ts
/** The query behind the grid. Next device follows the same query. */
export interface DeviceView {
  predicates: DevicePredicate[];
  sort: DeviceSort;
  selection: DeviceSelectionKey | null;
}
export type DeviceLoader = (
  offset: number,
  limit: number,
  view: DeviceView,
) => Promise<DevicePage | null>;
```

3. Replace `initialSortState` and its two comment lines with:

```ts
export function defaultGridState(): GridState {
  return { sort: { sortModel: [{ colId: 'serialNumber', sort: 'asc' }] } };
}

/** The server keeps the selection. Restoring row selection state would fight it. */
export function savedGridState(state: GridState): GridState {
  const { rowSelection: _selection, ...rest } = state;
  return rest;
}
```

If lint rejects the unused `_selection` binding, use `const rest = { ...state }; delete rest.rowSelection; return rest;` and ledger the ruling.

4. Above `deviceDatasource`, put the comment `/** Adapt LibreGrid block requests to the device query endpoint (GRID-01). */`. Replace the body of `getRows` with:

```ts
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      const offset = params.request.startRow ?? 0;
      const limit = Math.min(
        200,
        Math.max(1, (params.request.endRow ?? offset + 100) - offset),
      );
      let predicates: DevicePredicate[];
      try {
        predicates = predicatesFromFilterModel(
          params.request.filterModel as FilterModel | null,
        );
      } catch {
        params.fail();
        return;
      }
      const view: DeviceView = {
        predicates,
        sort: sortFromModel(params.request.sortModel),
        selection: null,
      };
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

- [ ] **Step 4: Change the store**

In `frontend/src/app/devices/devices.store.ts`:

1. Add the imports:

```ts
import type { GridState } from 'ag-grid-community';
import type { DeviceView } from './device-datasource';
import { samePredicates } from './device-filter-model';
import {
  DeviceSelectionProvider,
  deviceSelectionTab,
} from './device-selection';
```

Remove `type DeviceQuery` from the contracts import if nothing else uses it.

2. Add before the class:

```ts
const defaultView = (): DeviceView => ({
  predicates: [],
  sort: { field: 'serialNumber', direction: 'asc' },
  selection: null,
});
```

3. Replace the `sort` signal with:

```ts
  /** The query the grid last ran. Next device follows it. */
  readonly view = signal<DeviceView>(defaultView());
  /** Grid columns, filters, sort, and page, kept while device details are open. */
  readonly gridState = signal<GridState | null>(null);
  readonly selection = new DeviceSelectionProvider((path, body) =>
    this.call(path, body),
  );
  readonly selectionTab = deviceSelectionTab();
```

4. In `reset()`, replace the `sort` line with:

```ts
this.view.set(defaultView());
this.gridState.set(null);
this.selection.spec.set(null);
```

5. Replace `rows` with:

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
    // A response for a query that changed meanwhile must not replace the counts.
    if (view !== this.view() || revision !== this.revision()) return page;
    this.page.set({
      matching: page.matching,
      total: page.total,
      observedAt: page.observedAt,
    });
    return page;
  }
```

6. Replace `setPredicates` and `setSort` with:

```ts
  /** Chips and column filters both land here. The grid applies them and reloads itself. */
  setPredicates(predicates: DevicePredicate[]): void {
    if (samePredicates(predicates, this.predicates())) return;
    this.predicates.set(predicates);
    this.position.set(null);
  }

  /** The grid reports each query it runs. A different query forgets the opened row. */
  setView(view: DeviceView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view())) return;
    this.view.set(view);
    this.position.set(null);
  }
```

- [ ] **Step 5: Change the grid**

In `frontend/src/app/devices/device-grid.ts`:

1. Add `SetFilterModule` from `@libregrid/set-filter` to the registered modules. Import `predicatesFromFilterModel` and `filterModelUpdate` from `./device-filter-model`. Replace the `initialSortState` and `DeviceSort` imports with `defaultGridState` and `savedGridState`. Add `DeviceOrgUnit` and `DevicePredicate` to the contracts type import, and `GridState` to the `ag-grid-community` type import.
2. Replace the `sort` input with:

```ts
  /** Saved grid state to open with, such as after Back to devices. */
  readonly state = input<GridState | null>(null);
  /** Receives the grid state when the grid closes. */
  readonly saveState = input<(state: GridState) => void>(() => undefined);
  /** The chips. The grid shows them as column filters. */
  readonly predicates = input<DevicePredicate[]>([]);
  /** Organization units for the OrgUnit set filter. */
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  readonly filtersChange = output<DevicePredicate[]>();
```

3. In the constructor, add:

```ts
effect(() => {
  const predicates = this.predicates();
  untracked(() => this.applyPredicates(predicates));
});
```

4. In `ngOnInit`, change these options:

```ts
      columnDefs: deviceColumnDefs(open, {
        orgUnits: () => this.orgUnits().map((unit) => unit.path),
      }),
      initialState: this.state() ?? defaultGridState(),
      onFilterChanged: () => this.filtersChanged(),
      onGridPreDestroyed: ({ state }) => this.saveState()(savedGridState(state)),
```

5. In `ready`, call `this.applyPredicates(this.predicates());` before `this.reload();`.
6. Change `reload` so the loader passes the view:

```ts
      deviceDatasource(
        (offset, limit, view) => this.load()(offset, limit, view),
        (page) => this.restore(page),
      ),
```

7. Add the methods:

```ts
  private applyPredicates(predicates: readonly DevicePredicate[]): void {
    const api = this.api;
    const next = api && filterModelUpdate(api.getFilterModel(), predicates);
    if (next) api?.setFilterModel(next);
  }

  private filtersChanged(): void {
    const api = this.api;
    if (!api) return;
    try {
      this.filtersChange.emit(predicatesFromFilterModel(api.getFilterModel()));
    } catch {
      // The datasource fails the load for a model the query cannot express.
    }
  }
```

- [ ] **Step 6: Change the page**

In `frontend/src/app/devices/devices.ts`:

1. Replace the `DeviceSort` import with `import type { DeviceView } from './device-datasource';` and add `import type { GridState } from 'ag-grid-community';`.
2. Replace `load` with:

```ts
  protected readonly load = (
    offset: number,
    limit: number,
    view: DeviceView,
  ) => {
    this.store.setView(view);
    return this.store.rows(offset, limit);
  };
  protected readonly saveState = (state: GridState) =>
    this.store.gridState.set(state);
```

3. Replace `apply` with:

```ts
  /** One filter per field. A chip for a filtered field replaces that filter. */
  protected apply(predicate: DevicePredicate): void {
    const index = this.editingIndex();
    const current = this.store.predicates();
    const at =
      index !== null && index < current.length
        ? index
        : current.findIndex((item) => item.field === predicate.field);
    // The editor emits closed next. editorClosed() clears the index and restores focus.
    this.store.setPredicates(
      at === -1
        ? [...current, predicate]
        : current.map((item, position) => (position === at ? predicate : item)),
    );
  }
```

In `frontend/src/app/devices/devices.html`, replace the `[sort]="store.sort()"` binding on `app-device-grid` with:

```html
[state]="store.gridState()" [saveState]="saveState"
[predicates]="store.predicates()" [orgUnits]="store.orgUnits()"
(filtersChange)="store.setPredicates($event)"
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run-many -t lint build -p frontend --skip-nx-cache`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: drive the device query from the grid filter model"
```

---

### Task 7: Paging, column tools, status bar, and selection in the grid

**Files:**

- Create: `frontend/src/app/devices/device-grid-options.ts`
- Create: `frontend/src/app/devices/device-grid-options.spec.ts`
- Create: `frontend/src/app/devices/device-status-panel.ts`
- Create: `frontend/src/app/devices/device-status-panel.spec.ts`
- Modify: `frontend/src/app/devices/device-datasource.ts`
- Modify: `frontend/src/app/devices/device-grid.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`
- Modify: `frontend/src/app/devices/devices.store.ts`
- Modify: `frontend/src/app/devices/devices.ts`
- Modify: `frontend/src/app/devices/devices.html`
- Modify: `frontend/src/app/devices/devices.css`
- Modify: `frontend/src/app/devices/devices.spec.ts`

**Interfaces:**

- Consumes: the Task 5 provider and `DEVICE_GRID_ID`, plus the Task 6 store and grid.
- Produces: in `device-grid-options.ts`:
  - `deviceGridFeatures({ provider, tabId, footer }): GridOptions<DeviceRow>`.
  - `class SelectionFooterPanel implements IStatusPanelComp`.
  - `showRow(api, index): void`.
- Produces: `DeviceStatusPanel`, an Angular status panel that reads `DevicesStore`.
- Produces: `deviceDatasource(load, onLoaded?, selection?: DeviceSelectionKey)`. When the grid option `ssrmSelectionViewActive` is on, the view carries `selection`.
- Produces: the `DeviceGrid` input `selection: { provider: ServerSideSelectionProvider; tabId: string }`. The grid loses `optionalColumns` and `rangeChange`. The store loses `optionalColumns`. The page loses the Columns menu and its own footer.

GRID-01 keeps counts, freshness, selection, and paging in the AG Grid footer. The Columns side bar replaces the Columns menu in the filter row.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/app/devices/device-grid-options.spec.ts`:

```ts
import type { IStatusPanelParams } from 'ag-grid-community';
import type { SsrmSelectionService } from '@libregrid/server-side-selection';
import { vi } from 'vitest';
import {
  SelectionFooterPanel,
  deviceGridFeatures,
  showRow,
} from './device-grid-options';
import { DeviceStatusPanel } from './device-status-panel';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

it('pages, shows column tools and the status bar, and selects on the server', () => {
  const footer = document.createElement('div');
  const provider = {
    getSpec: vi.fn(),
    applyOps: vi.fn(),
    resolveSelected: vi.fn(),
  };
  const options = deviceGridFeatures({ provider, tabId, footer });
  expect(options.pagination).toBe(true);
  expect(options.paginationPageSize).toBe(100);
  expect(options.paginationPageSizeSelector).toEqual([50, 100, 250]);
  expect(options.sideBar).toEqual({ toolPanels: ['columns', 'filters'] });
  expect(
    options.statusBar?.statusPanels.map((panel) => panel.statusPanel),
  ).toEqual([DeviceStatusPanel, SelectionFooterPanel]);
  expect(options.rowSelection).toMatchObject({
    mode: 'multiRow',
    selectAll: 'currentPage',
  });
  expect(options.ssrmSelection).toMatchObject({
    provider,
    gridId: 'devices',
    tabId,
  });
  const attachFooter = vi.fn();
  options.ssrmSelection?.onReady?.({
    attachFooter,
  } as unknown as SsrmSelectionService);
  expect(attachFooter).toHaveBeenCalledWith(footer);
  const panel = new SelectionFooterPanel();
  panel.init({ host: footer } as unknown as IStatusPanelParams & {
    host: HTMLElement;
  });
  expect(panel.getGui()).toBe(footer);
});

it('opens the page that holds a remembered row', () => {
  const calls: unknown[] = [];
  showRow(
    {
      paginationGetPageSize: () => 100,
      paginationGetCurrentPage: () => 0,
      paginationGoToPage: (page: number) => void calls.push(['page', page]),
      ensureIndexVisible: (
        index: number,
        position?: 'top' | 'bottom' | 'middle' | null,
      ) => void calls.push(['row', index, position]),
    },
    150,
  );
  expect(calls).toEqual([
    ['page', 1],
    ['row', 150, 'middle'],
  ]);
});
```

Create `frontend/src/app/devices/device-status-panel.spec.ts`:

```ts
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DeviceSelectionSpec } from '@campus/application-contracts';
import { DeviceStatusPanel } from './device-status-panel';
import { DevicesStore } from './devices.store';

function setup(
  page: { matching: number; total: number; observedAt: string } | null,
) {
  const store = {
    page: signal(page),
    offline: signal(false),
    sync: signal({ stale: false }),
    selection: { spec: signal<DeviceSelectionSpec | null>(null) },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: DevicesStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(DeviceStatusPanel);
  fixture.detectChanges();
  return {
    store,
    element: fixture.nativeElement as HTMLElement,
    render: () => fixture.detectChanges(),
  };
}

it('shows counts and the observation time', () => {
  const { element } = setup({
    matching: 1234,
    total: 128431,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  expect(element.textContent).toContain(
    '1,234 matching devices · 128,431 in district',
  );
  expect(element.textContent).toContain('Inventory observed');
});

it('names cached and stale inventory', () => {
  const { store, element, render } = setup({
    matching: 10,
    total: 450,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  store.sync.set({ stale: true });
  render();
  expect(element.textContent).toContain('Refresh required');
  store.offline.set(true);
  render();
  expect(element.textContent).toContain('Connection unavailable');
});

it('shows what Select All captured', () => {
  const { store, element, render } = setup(null);
  expect(element.textContent).toContain('Loading devices…');
  store.selection.spec.set({
    terms: [
      {
        type: 'all',
        predicates: [
          { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
        ],
      },
    ],
    added: 0,
    excluded: 1,
    selectedCount: 95,
  });
  render();
  expect(element.textContent).toContain(
    'Selected by filter: Asset tag starts with: HS-04 · 1 excluded',
  );
});
```

In `frontend/src/app/devices/device-grid.spec.ts`, append:

```ts
it('limits the query to the selection while Show All Selected is on', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [],
    matching: 0,
    total: 450,
    observedAt: null,
  });
  const key = {
    gridId: 'devices' as const,
    tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  };
  deviceDatasource(load, undefined, key).getRows({
    request: { startRow: 0, endRow: 100, sortModel: [], filterModel: {} },
    api: {
      getGridOption: (name: string) => name === 'ssrmSelectionViewActive',
    },
    success: vi.fn(),
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0][2].selection).toEqual(key);
});
```

In `frontend/src/app/devices/devices.spec.ts`:

1. In `GridStub`, remove `optionalColumns` and `rangeChange`. Add `readonly selection = input<unknown>();`.
2. In the fake store, remove `optionalColumns`. Add `selection: { spec: signal(null) },` and `selectionTab: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',`.
3. Delete the test `shows counts and the observation time in the footer`. `device-status-panel.spec.ts` covers it now.
4. Append:

```ts
it('keeps the grid visible while Show All Selected finds nothing', () => {
  const { store, element, render } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 0, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('No devices match these filters');
  store.view.set({
    predicates: twoChips,
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: { gridId: 'devices', tabId: 't' },
  });
  render();
  expect(element.textContent).not.toContain('No devices match these filters');
  expect(
    element.querySelector('app-device-grid')?.classList.contains('hidden'),
  ).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. `./device-grid-options` and `./device-status-panel` do not exist, and `deviceDatasource` ignores the selection view.

- [ ] **Step 3: Add the status panel**

Create `frontend/src/app/devices/device-status-panel.ts`:

```ts
import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { IStatusPanelAngularComp } from 'ag-grid-angular';
import { DevicesStore } from './devices.store';
import { selectionScope } from './device-selection';

/** Counts, freshness, and selection scope in the grid status bar (GRID-01, SELECT-01). */
@Component({
  selector: 'app-device-status-panel',
  imports: [DatePipe],
  template: `
    <div class="status" aria-live="polite">
      @if (store.page(); as page) {
        <p>
          {{ count(page.matching) }} matching devices ·
          {{ count(page.total) }} in district
        </p>
        <p>
          @if (store.offline()) {
            Cached inventory: {{ page.observedAt | date: 'MMM d, h:mm a' }} ·
            Connection unavailable
          } @else if (store.sync()?.stale) {
            Stale inventory · Last complete observation
            {{ page.observedAt | date: 'MMM d, h:mm a' }} · Refresh required
          } @else {
            Inventory observed {{ page.observedAt | date: 'MMM d, h:mm a' }}
          }
        </p>
      } @else {
        <p>Loading devices…</p>
      }
      @if (scope(); as text) {
        <p>{{ text }}</p>
      }
    </div>
  `,
  styles: `
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: var(--cc-space-md);
      color: var(--cc-text-secondary);
    }
    p {
      margin: 0;
    }
  `,
})
export class DeviceStatusPanel implements IStatusPanelAngularComp {
  protected readonly store = inject(DevicesStore);
  protected readonly scope = computed(() =>
    selectionScope(this.store.selection.spec()),
  );

  agInit(): void {
    // The panel reads the devices store, not the grid parameters.
  }

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }
}
```

- [ ] **Step 4: Add the grid feature options**

Create `frontend/src/app/devices/device-grid-options.ts`:

```ts
import type {
  GridApi,
  GridOptions,
  IStatusPanelComp,
  IStatusPanelParams,
} from 'ag-grid-community';
import type {
  ServerSideSelectionProvider,
  SsrmSelectionService,
} from '@libregrid/server-side-selection';
import type { DeviceRow } from '@campus/application-contracts';
import { DEVICE_GRID_ID } from './device-selection';
import { DeviceStatusPanel } from './device-status-panel';

/** Hosts the LibreGrid selection footer in the grid status bar (SELECT-01). */
export class SelectionFooterPanel implements IStatusPanelComp {
  private gui!: HTMLElement;

  init(params: IStatusPanelParams & { host: HTMLElement }): void {
    this.gui = params.host;
  }

  getGui(): HTMLElement {
    return this.gui;
  }

  refresh(): boolean {
    return true;
  }
}

export interface DeviceGridFeatures {
  provider: ServerSideSelectionProvider;
  tabId: string;
  footer: HTMLElement;
}

/** Paging, column tools, the status bar, and server-side selection. */
export function deviceGridFeatures(
  features: DeviceGridFeatures,
): GridOptions<DeviceRow> {
  return {
    pagination: true,
    paginationPageSize: 100,
    paginationPageSizeSelector: [50, 100, 250],
    sideBar: { toolPanels: ['columns', 'filters'] },
    statusBar: {
      statusPanels: [
        { statusPanel: DeviceStatusPanel, align: 'left' },
        {
          statusPanel: SelectionFooterPanel,
          align: 'right',
          statusPanelParams: { host: features.footer },
        },
      ],
    },
    rowSelection: {
      mode: 'multiRow',
      selectAll: 'currentPage',
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,
    },
    selectionColumnDef: { pinned: 'left' },
    ssrmSelection: {
      provider: features.provider,
      gridId: DEVICE_GRID_ID,
      tabId: features.tabId,
      onReady: (service: SsrmSelectionService) =>
        service.attachFooter(features.footer),
    },
  };
}

/** Open the page that holds a row, then scroll to it. Next device can leave the page that Back returns to. */
export function showRow(
  api: Pick<
    GridApi,
    | 'paginationGetPageSize'
    | 'paginationGetCurrentPage'
    | 'paginationGoToPage'
    | 'ensureIndexVisible'
  >,
  index: number,
): void {
  const page = Math.floor(index / api.paginationGetPageSize());
  if (page !== api.paginationGetCurrentPage()) api.paginationGoToPage(page);
  api.ensureIndexVisible(index, 'middle');
}
```

- [ ] **Step 5: Read the selection view in the datasource**

In `frontend/src/app/devices/device-datasource.ts`, change the `deviceDatasource` signature and the view:

```ts
export function deviceDatasource(
  load: DeviceLoader,
  onLoaded?: (page: DevicePage) => void,
  selection?: DeviceSelectionKey,
): IServerSideDatasource<DeviceRow> {
```

```ts
const view: DeviceView = {
  predicates,
  sort: sortFromModel(params.request.sortModel),
  // Show All Selected limits the query to this tab's selection.
  selection:
    selection && params.api.getGridOption('ssrmSelectionViewActive')
      ? selection
      : null,
};
```

The `ssrmSelectionViewActive` option type comes from the package's grid option declarations. `device-grid-options.ts` imports the package types, which puts those declarations in the program. If the type check still rejects the option name here, add `import type { SsrmSelectionOptions } from '@libregrid/server-side-selection';` and use it in a type position, then ledger the ruling.

- [ ] **Step 6: Change the grid**

In `frontend/src/app/devices/device-grid.ts`:

1. Register the modules:

```ts
ModuleRegistry.registerModules([
  AllCommunityModule,
  ServerSideRowModelModule,
  ServerSideSelectionModule,
  SetFilterModule,
  ColumnMenuModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  StatusBarModule,
]);
```

Import them from `@libregrid/server-side-selection`, `@libregrid/set-filter`, `@libregrid/menu`, `@libregrid/side-bar`, `@libregrid/columns-tool-panel`, `@libregrid/filters-tool-panel`, and `@libregrid/status-bar`. Import `type ServerSideSelectionProvider` from `@libregrid/server-side-selection`. Import `deviceGridFeatures` and `showRow` from `./device-grid-options`, and `DEVICE_GRID_ID` from `./device-selection`.

2. Change the template to:

```html
<ag-grid-angular
  class="device-grid"
  [gridOptions]="options"
  (gridReady)="ready($event)"
/>
```

3. Add to the styles:

```css
:host ::ng-deep .lgr-ssrm-selection-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-md);
  color: var(--cc-text-primary);
}
:host ::ng-deep .lgr-ssrm-selection-footer button {
  color: var(--cc-accent);
  font: inherit;
}
```

4. Remove the `optionalColumns` input, the `rangeChange` output, `DeviceRange`, the optional-columns effect, `applyColumns`, `updated`, and `emitRange`. Remove the `OptionalDeviceColumn` import.
5. Add the input and the footer host:

```ts
  readonly selection = input.required<{
    provider: ServerSideSelectionProvider;
    tabId: string;
  }>();
  /** The selection footer lives in the status bar. LibreGrid fills it on ready. */
  private readonly footer = document.createElement('div');
```

6. In `ngOnInit`, add `...deviceGridFeatures({ provider: this.selection().provider, tabId: this.selection().tabId, footer: this.footer }),` as the last member of the options. Change `maxBlocksInCache` to `10`. That keeps a cache-sized ID batch within the API's 2,000-ID limit.
7. In `ready`, remove the `applyColumns` call.
8. In `reload`, pass the selection key as the third argument:

```ts
      deviceDatasource(
        (offset, limit, view) => this.load()(offset, limit, view),
        (page) => this.restore(page),
        { gridId: DEVICE_GRID_ID, tabId: this.selection().tabId },
      ),
```

9. In `restore`, replace the `setTimeout` line with:

```ts
const api = this.api;
if (api) setTimeout(() => showRow(api, index));
```

- [ ] **Step 7: Change the store and the page**

In `frontend/src/app/devices/devices.store.ts`, delete `OptionalDeviceColumn` and the `optionalColumns` signal.

In `frontend/src/app/devices/devices.ts`:

1. Remove `DatePipe` from the imports. Only the deleted footer used it. Keep `MatMenuModule` for the Refresh menu.
2. Remove `range`, `count`, `toggleColumn`, the `DeviceRange` import, and the `OptionalDeviceColumn` import.
3. Change `noMatches` and add the selection binding:

```ts
  protected readonly noMatches = computed(
    () =>
      this.store.page()?.matching === 0 &&
      this.store.predicates().length > 0 &&
      // Show All Selected keeps the grid, so its footer can return to all records.
      !this.store.view().selection,
  );
  protected readonly selection = {
    provider: this.store.selection,
    tabId: this.store.selectionTab,
  };
```

In `frontend/src/app/devices/devices.html`:

1. Delete the Columns button and the `columnsMenu` `mat-menu`.
2. Delete the whole `<footer class="grid-footer"> ... </footer>` element.
3. On `app-device-grid`, remove `[optionalColumns]` and `(rangeChange)`, and add `[selection]="selection"`.

In `frontend/src/app/devices/devices.css`, delete the `.grid-footer` and `.grid-footer p` rules.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run-many -t lint build -p frontend --skip-nx-cache`
Expected: PASS.

- [ ] **Step 9: Look at the grid**

Start the client review environment: `npm exec -- nx run api-e2e:client-review`. Stop any running instance first. Open `/devices` in Chrome, sign in, and refresh the inventory. Check these points:

- The selection column comes first and the details column second.
- The pagination bar reads "1 to 100 of 450", and the page size selector offers 50, 100, and 250.
- The Columns and Filters tabs open their panels.
- The Battery header filter lists the five classes by label.
- The status bar shows the counts on the left and the selection footer on the right.

Ledger a ruling for any library behavior that differs from this plan, together with its fix.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: page, select, and arrange devices with LibreGrid tools"
```

---

### Task 8: Browser check and workflow record

**Files:**

- Modify: `api-e2e/devices-browser.mjs`
- Modify: `docs/workflows/device-browsing.md`
- Modify: `docs/current-work.md`
- Modify: `docs/testing/client-review.md`
- Modify: `docs/document-index.csv`

**Interfaces:**

- Consumes: every earlier task through the real application. At the start of the new steps, the grid has the `Asset tag starts with: HS-04` chip and Serial ascending order.

- [ ] **Step 1: Write the browser check**

In `api-e2e/devices-browser.mjs`, insert after the assertion that shows `96 matching devices · 450 in district` following the return from C0A1-0002, before `await page.goto(... synthetic-device-9)`:

```js
// A column set filter becomes a chip (filtering decision).
const batteryHeader = page.getByRole('columnheader', { name: 'Battery' });
await batteryHeader.hover();
await batteryHeader.locator('.ag-header-cell-filter-button').click();
await page
  .getByRole('checkbox', { name: 'Select all filtered values' })
  .uncheck();
await page.getByRole('checkbox', { name: 'Replace soon', exact: true }).check();
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await expect(
  page.getByRole('button', { name: 'Battery · Replace soon', exact: true }),
).toBeVisible();
await expect(
  page.getByText('29 matching devices · 450 in district'),
).toBeVisible();

// Select All captures the filtered devices and survives filter changes (SELECT-01).
await page.getByRole('button', { name: 'Select All (29)' }).click();
await expect(page.getByText('Total Selected: 29')).toBeVisible();
await expect(
  page.getByText(
    'Selected by filter: Asset tag starts with: HS-04 and Battery · Replace soon',
  ),
).toBeVisible();
await page
  .getByRole('button', { name: 'Remove filter Battery · Replace soon' })
  .click();
await expect(
  page.getByText('96 matching devices · 450 in district'),
).toBeVisible();
await expect(page.getByText('Total Selected: 29')).toBeVisible();
await page
  .getByRole('row', { name: /Open details for C0A1-0001/ })
  .getByRole('checkbox')
  .uncheck();
await expect(page.getByText('Total Selected: 28')).toBeVisible();
await page.getByRole('button', { name: 'Show All Selected (28)' }).click();
await expect(
  page.getByText('28 matching devices · 450 in district'),
).toBeVisible();
await auditAccessibility(page, 'devices-selection');
await page.getByRole('button', { name: 'Show All Records' }).click();
await expect(
  page.getByText('96 matching devices · 450 in district'),
).toBeVisible();
await page.getByRole('button', { name: 'Deselect All' }).click();
await expect(page.getByText('Total Selected: 0')).toBeVisible();

// Back to devices returns to the page of the opened device (paging decision).
await page
  .getByRole('button', { name: 'Remove filter Asset tag starts with: HS-04' })
  .click();
const summary = page.locator('.ag-paging-row-summary-panel');
await expect(summary).toHaveText(/1\s*to\s*100\s*of\s*450/);
await page.getByRole('button', { name: 'Next Page' }).click();
await expect(summary).toHaveText(/101\s*to\s*200\s*of\s*450/);
await page.getByRole('button', { name: 'Open details for C0A1-0064' }).click();
await page.getByRole('button', { name: 'Next device' }).click();
await expect(
  page.getByRole('heading', { name: 'C0A1-0065', level: 1 }),
).toBeVisible();
await page.getByRole('link', { name: 'Back to devices' }).click();
await expect(summary).toHaveText(/101\s*to\s*200\s*of\s*450/);
await expect(
  page.getByRole('button', { name: 'Open details for C0A1-0065' }),
).toBeInViewport();

// The Columns side bar shows and hides columns (column tools decision).
// AG Grid renders only the headers in view, so the check hides a visible column.
await page.getByRole('tab', { name: 'Columns' }).click();
await page.getByRole('checkbox', { name: 'Show Notes' }).check();
await expect(page.getByRole('checkbox', { name: 'Show Notes' })).toBeChecked();
await page.getByRole('checkbox', { name: 'Show Model' }).uncheck();
await expect(
  page.getByRole('columnheader', { name: 'Model', exact: true }),
).toHaveCount(0);
await auditAccessibility(page, 'devices-columns');
```

Add these lines to the returned list before the deep-link line:

```js
      'a column set filter becomes a chip and narrows the grid: pass',
      'Select All captures the filtered devices and survives filter changes: pass',
      'Show All Selected limits the grid to selected devices: pass',
      'Back to devices returns to the page of the opened device: pass',
      'the Columns side bar shows and hides columns: pass',
```

- [ ] **Step 2: Run the browser check**

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache > .superpowers/sdd/2026-10-05-device-grid-features/task8-e2e.log 2>&1; tail -60 .superpowers/sdd/2026-10-05-device-grid-features/task8-e2e.log`
Expected: PASS, with all four device accessibility audits passing.

A failure here usually comes from a LibreGrid locator or an axe finding in LibreGrid markup. Read the page in Chrome before changing anything:

- For a locator, use the element's actual accessible name.
- For an axe finding, fix it with an attribute or a `--cc-*` style in `device-grid.ts`.
- Ledger each change as a ruling.
- Do not disable an axe rule.

- [ ] **Step 3: Update the workflow record**

In `docs/workflows/device-browsing.md`, make these changes:

1. In "Interaction", replace `The footer shows the matching count, the district total, the inventory observation time, and the row range.` with:

```markdown
The grid pages through the devices. The paging bar shows the row range and the page size.
Each column header has a filter. The Filters side bar lists the same filters.
The Columns side bar shows, hides, orders, and pins columns.
The checkbox column selects devices. Select All in the status bar selects every device that matches the filters.
The status bar shows the matching count, the district total, the inventory observation time, and the selection.
```

2. In "Implementation defaults", delete the Columns menu line and the OrgUnit filter line. Add:

```markdown
- The Columns side bar shows or hides Annotated location and Notes. It replaces the Columns menu in the filter row.
- Each field has one filter. A chip for a field that already has a column filter replaces that filter.
- The OrgUnit set filter lists the OrgUnits that hold devices as a tree. Choosing a unit in the filter row includes the units inside it.
- An empty set filter matches no devices.
- Enter on the details cell opens device details. Space toggles the row's selection.
- A selection belongs to one person and one browser tab. It survives reloads of that tab and expires 12 hours after its last change.
- The status bar names the filters that Select All captured and counts the devices added or excluded since.
- An expired selection shows as empty. The expired-selection state from SELECT-01 arrives with the first device action.
- The selection footer uses the LibreGrid labels: Select All, Deselect All, Show All Selected, and Show All Records.
```

3. In "Design", replace `Deviations from the frames: no School column, no selection column or footer selection controls, and no Bulk Actions or Update device.` with:

```markdown
Deviations from the frames: no School column, no Bulk Actions, and no Update device.
```

4. In "Completion", add after item 5:

```markdown
6. Filter from a column header and see the matching chip. Show and hide a column from the Columns side bar.
7. Select All under a filter, change the filters, and use Show All Selected.
8. Move to a later page, open a device there, and return to that page.
```

In `docs/current-work.md`, replace `Battery health uses Google's classification. The School column, selection, Bulk Actions, and every device change are excluded.` with:

```markdown
Battery health uses Google's classification. The owner added grid tools, paging, and server-side selection on 2026-10-05.
The School column, Bulk Actions, and every device change are excluded.
```

In `docs/testing/client-review.md`, replace the Devices item with:

```markdown
- **Devices:** Select **Refresh inventory**, add a filter, open a device, and use **Next device** and **Back to devices**.
  Filter from a column header, select devices, and use **Show All Selected** in the status bar. Page through the grid and use the Columns side bar.
  The simulated customer has 450 devices with all battery classes.
```

In `docs/document-index.csv`, set the inspection field of the `docs/workflows/device-browsing.md`, `docs/current-work.md`, and `docs/testing/client-review.md` rows to `"Device grid features recorded, 2026-10-05"`. Preserve the CRLF line endings by editing bytes, as the earlier plans did.

- [ ] **Step 4: Run every check**

Run: `npm exec -- nx run-many -t lint test build -p application-contracts api frontend --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api-e2e/devices-browser.mjs docs/workflows/device-browsing.md docs/current-work.md docs/testing/client-review.md docs/document-index.csv
git commit -m "test: filter, select, and page devices in the browser check"
```

## After this plan

- Restart the client review environment with the new build and give the owner its address.
- Plan server-side grouping by OrgUnit, model, and battery class, with counts per group. Group selection terms (`selectGroup` and `deselectGroup`) arrive with it.
- The live Easton check still waits for the owner to add both device scopes.
