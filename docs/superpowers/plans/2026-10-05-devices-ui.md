# Devices UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the administrator a working Devices page: a server-side grid with typed filters, Refresh all, the designed states, and a device details page with battery health.

**Architecture:** A root-provided `DevicesStore` holds filters, sort, sync state, and the last opened row position, so details and the grid share one context. The grid is AG Grid Community with LibreGrid's server-side row model, loading blocks from `POST /api/devices/query`. A typed filter component implements GRID-04. The page and details components compose the Figma states from the store.

**Tech Stack:** Angular 22 (standalone components, signals, built-in control flow), Angular Material 22, AG Grid Community 36.2.0, `@libregrid/server-side-row-model` 1.3.4, Vitest through `@angular/build:unit-test`, Playwright in `api-e2e`.

**Spec:** [docs/workflows/device-browsing.md](../../workflows/device-browsing.md). The data path already exists from [the backend plan](2026-10-05-device-inventory-backend.md).

## Global Constraints

- Inspect the listed Figma frames before building each screen: inventory `94:3`, details `94:39`, filter picker `175:1337` and matches `175:1562`, editors `176:1503`, `176:1951`, `176:2181`, `176:2636`, loading `107:317`, empty `107:447`, offline `108:173`, stale `108:605`.
- Exclude the School column, row selection, Select All, Show All Selected, Refresh selected, Bulk Actions, Update device, Latest command, and the battery coverage page (`105:146`).
- Battery copy names Google's classification: Normal above 80%, Replace soon from 75% to 80%, Replace now below 75% of design capacity. No district thresholds.
- Use exactly `ag-grid-community@36.2.0`, `ag-grid-angular@36.2.0`, and `@libregrid/server-side-row-model@1.3.4`, the GRID-02 qualified set. Register grid modules in the lazily loaded devices code, not at bootstrap.
- Call the API only through `AuthStore.request`. Use the existing `--cc-*` tokens. Do not add palettes.
- Filter entry follows GRID-04: Add a filter becomes a combobox, matched fields come before shortcut matches, Apply is explicit, Escape cancels and restores focus.
- Every icon-only control has an accessible name. The browser check runs the existing axe audit on both pages.
- Applicable rule IDs for the handoff: UI-01, UI-03, GRID-01, GRID-02, GRID-03, GRID-04, DETAIL-01, DETAIL-02.
- Repository prose follows the writing rules in `AGENTS.md`.
- Run tasks through Nx: `npm exec -- nx run <project>:<target> --skip-nx-cache`.

## Review Focus

1. **A refresh finishes while filters are active.** The grid reloads with the same filters and shows the new counts. Test: Task 3 `refreshAll` test.
2. **The connection drops while browsing.** Rows stay visible, the offline banner appears, and Reconnect reloads. Tests: Task 3 offline test, Task 6 offline state test.
3. **Filter text that is only spaces.** Apply stays disabled. Test: Task 5 blank value test.
4. **Next device on the last matching row.** The button is disabled. Test: Task 7 last row test.
5. **A deep link to a device without visiting the grid.** Details load and Next device is disabled. Test: Task 7 deep link test.

---

### Task 1: OrgUnit list endpoint and device page routes at the edge

**Files:**
- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`
- Modify: `api/src/app/devices/devices.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Modify: `deployment/bootstrap/application-edge.mjs`
- Modify: `deployment/bootstrap/application-edge.test.mjs`
- Modify: `api-e2e/devices-api.mjs`

**Interfaces:**
- Produces: `deviceOrgUnitSchema`, `deviceOrgUnitsSchema`, and type `DeviceOrgUnit = { path: string; devices: number }` from `@campus/application-contracts`.
- Produces: `GET /api/devices/org-units` returning `{ orgUnits: DeviceOrgUnit[] }`. It lists the distinct OrgUnit paths of the published inventory with device counts, ordered by path.
- Produces: the edge serves the frontend for `/devices` and `/devices/<id>` in phase 3.

The OrgUnit filter needs a tree. Reading it from the published devices avoids another Google scope.

- [ ] **Step 1: Write the failing tests**

Append to `libs/application-contracts/src/lib/devices.test.mjs`, and add `deviceOrgUnitsSchema` to its import from `./devices.ts`:

```js
test('organization unit lists carry a path and a device count', () => {
  assert.equal(deviceOrgUnitsSchema.safeParse([{ path: '/School A', devices: 150 }]).success, true);
  assert.equal(deviceOrgUnitsSchema.safeParse([{ path: 'School A', devices: 1 }]).success, false);
  assert.equal(deviceOrgUnitsSchema.safeParse([{ path: '/', devices: -1 }]).success, false);
});
```

Append to `api/src/app/devices/device-query.test.mjs`, and add `deviceOrgUnitsSql` to its import from `./device-query.ts`:

```js
test('organization units come from the published inventory in path order', () => {
  const sql = deviceOrgUnitsSql('C0123456');
  assert.match(sql.text, /FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.sync_id=s\.current_sync_id/);
  assert.match(sql.text, /GROUP BY d\.org_unit_path ORDER BY d\.org_unit_path LIMIT 10000$/);
  assert.deepEqual(sql.values, ['C0123456']);
});
```

In `deployment/bootstrap/application-edge.test.mjs`, add to the allowed `routes` table:

```js
      ['GET', '/api/devices/org-units', 'api'],
      ['GET', '/devices', 'frontend'],
      ['GET', '/devices/synthetic-device-1', 'frontend'],
```

Add to the rejected table:

```js
      ['GET', '/devices/a/b', 404],
```

In `api-e2e/devices-api.mjs`, add after the `const first = await query({});` block:

```js
    const units = await api.get(`${root}/org-units`);
    assert.equal(units.status(), 200, await units.text());
    assert.deepEqual((await units.json()).orgUnits, [
      { path: '/', devices: 150 },
      { path: '/School A', devices: 150 },
      { path: '/School B', devices: 150 },
    ]);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm exec -- nx run-many -t test -p application-contracts api --skip-nx-cache`
Expected: FAIL. `deviceOrgUnitsSchema` and `deviceOrgUnitsSql` are not exported.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: FAIL with `GET /devices` returning 404.

- [ ] **Step 3: Add the contract, query, service method, and route**

Append to `libs/application-contracts/src/lib/devices.ts`:

```ts
export const deviceOrgUnitSchema = z.strictObject({
  path: orgUnitPath,
  devices: z.number().int().min(0),
});
export type DeviceOrgUnit = z.infer<typeof deviceOrgUnitSchema>;
export const deviceOrgUnitsSchema = z.array(deviceOrgUnitSchema).max(10000);
```

Append to `api/src/app/devices/device-query.ts`:

```ts
export function deviceOrgUnitsSql(customerId: string): SqlStatement {
  return {
    text: `SELECT d.org_unit_path,count(*)::integer AS devices ${from} WHERE s.customer_id=$1 GROUP BY d.org_unit_path ORDER BY d.org_unit_path LIMIT 10000`,
    values: [customerId],
  };
}
```

In `api/src/app/devices/devices.service.ts`, add `deviceOrgUnitsSchema` and `type DeviceOrgUnit` to the contracts import and `deviceOrgUnitsSql` to the `./device-query` import, then add this method to `DevicesService`:

```ts
  async orgUnits(session: SessionResponse): Promise<DeviceOrgUnit[]> {
    return this.read(
      session,
      async (client, customerId) => {
        const sql = deviceOrgUnitsSql(customerId);
        const rows = (await client.query(sql.text, sql.values)).rows;
        return deviceOrgUnitsSchema.parse(
          rows.map((row) => ({
            path: row['org_unit_path'],
            devices: row['devices'],
          })),
        );
      },
      [],
    );
  }
```

In `api/src/app/devices/devices.controller.ts`, add this handler directly before the `@Get(':deviceId')` handler. Nest matches routes in declaration order:

```ts
  @Get('org-units')
  async orgUnits(@Req() request: AuthenticatedRequest) {
    await this.current(request);
    return { orgUnits: await this.devices.orgUnits(request.session) };
  }
```

In `deployment/bootstrap/application-edge.mjs`, add `'/devices',` to `phase3Pages`. Add this pattern next to `deviceRead`:

```js
const devicePage = /^\/devices\/[A-Za-z0-9_-]{1,128}$/;
```

Then change the `page` computation to:

```js
  const page =
    pages.has(pathname) ||
    (phase === 3 && (phase3Pages.has(pathname) || devicePage.test(pathname)));
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm exec -- nx run-many -t test lint -p application-contracts api --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache`
Expected: PASS. It runs about three minutes.

- [ ] **Step 5: Commit**

```bash
git add libs/application-contracts api/src/app/devices deployment/bootstrap api-e2e/devices-api.mjs
git commit -m "feat: list device organization units and route device pages at the edge"
```

---

### Task 2: Grid dependencies and device field helpers

**Files:**
- Modify: `package.json`, `package-lock.json` (three exact dependencies)
- Create: `frontend/src/app/devices/device-fields.ts`
- Create: `frontend/src/app/devices/device-fields.spec.ts`

**Interfaces:**
- Consumes: `DevicePredicate`, `DeviceBattery`, `DeviceOrgUnit`, `DeviceQuery`, `DeviceSyncFailure`, `GoogleFailure`, `batteryFilterValueSchema` from `@campus/application-contracts`.
- Produces from `frontend/src/app/devices/device-fields.ts`:
  - types `DeviceSortField`, `BatteryFilterValue`, `DeviceFieldKind`, `DeviceField { id; label; kind; optional }`, `OrgUnitOption { path; label; depth }`
  - `DEVICE_FIELDS`, `TEXT_OPERATORS`, `DATE_OPERATORS`, `ORG_UNIT_OPERATORS`, `BATTERY_LABELS`
  - `fieldFor(id)`, `chipLabel(predicate)`, `shortcutLabel(predicate)`, `suggestions(text) → { fields: DeviceField[]; shortcuts: DevicePredicate[] }`
  - `orgUnitOptions(units, search) → OrgUnitOption[]`, `batteryText(battery)`, `relativeTime(iso, now?)`
  - `dateInputValue(iso)`, `dateInputToIso(value) → string | null`
  - `syncFailureText(failure)`, `telemetryFailureText(failure) → string | null`

- [ ] **Step 1: Install the qualified grid packages**

Run: `npm install --save-exact ag-grid-community@36.2.0 ag-grid-angular@36.2.0 @libregrid/server-side-row-model@1.3.4`
Expected: `package.json` lists the three exact versions. `npm ls ag-grid-community` shows one copy, 36.2.0.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/app/devices/device-fields.spec.ts`:

```ts
import type { DevicePredicate } from '@campus/application-contracts';
import {
  batteryText,
  chipLabel,
  dateInputToIso,
  dateInputValue,
  orgUnitOptions,
  relativeTime,
  shortcutLabel,
  suggestions,
  syncFailureText,
  telemetryFailureText,
} from './device-fields';

describe('device fields', () => {
  it('labels each filter type the way the chips read', () => {
    const day = new Date(2026, 9, 1).toISOString();
    const cases: [DevicePredicate, string][] = [
      [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }, 'Asset tag starts with: HS-04'],
      [{ field: 'notes', operator: 'isEmpty' }, 'Notes is empty'],
      [{ field: 'serialNumber', operator: 'equals', value: 'C0A1' }, 'Serial is: C0A1'],
      [{ field: 'orgUnitPath', operator: 'within', value: '/School A' }, 'Organization unit is within: /School A'],
      [{ field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] }, 'Battery · Replace soon, No battery report'],
      [{ field: 'lastContact', operator: 'before', value: day }, 'Device contact before: Oct 1, 2026'],
    ];
    for (const [predicate, label] of cases) expect(chipLabel(predicate)).toBe(label);
  });

  it('lists matched fields and identifier shortcuts for typed text', () => {
    const result = suggestions(' asset ');
    expect(result.fields.map((field) => field.label)).toEqual(['Asset tag']);
    expect(result.shortcuts.map(shortcutLabel)).toEqual([
      'Asset tag contains "asset"',
      'Serial contains "asset"',
    ]);
    const empty = suggestions('');
    expect(empty.fields).toHaveLength(8);
    expect(empty.shortcuts).toEqual([]);
  });

  it('builds the organization unit tree with ancestors and search', () => {
    const units = [{ path: '/School A/Library', devices: 3 }, { path: '/School B', devices: 1 }];
    expect(orgUnitOptions(units)).toEqual([
      { path: '/', label: 'All organization units', depth: 0 },
      { path: '/School A', label: 'School A', depth: 1 },
      { path: '/School A/Library', label: 'Library', depth: 2 },
      { path: '/School B', label: 'School B', depth: 1 },
    ]);
    expect(orgUnitOptions(units, 'library').map((unit) => unit.path)).toEqual(['/School A/Library']);
  });

  it('describes battery data and contact age', () => {
    expect(batteryText({ status: 'reported', health: 'replace-now', capacityPercent: 70, reportedAt: '2026-10-05T12:00:00Z' })).toBe('Replace now');
    expect(batteryText({ status: 'no-report' })).toBe('No battery report');
    expect(batteryText({ status: 'unavailable' })).toBe('Unavailable');
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(relativeTime(null, now)).toBe('Never');
    expect(relativeTime('2026-10-05T11:59:30Z', now)).toBe('Just now');
    expect(relativeTime('2026-10-05T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-10-05T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-01T12:00:00Z', now)).toBe('4 d ago');
  });

  it('converts date inputs to local midnight and back', () => {
    const iso = dateInputToIso('2026-10-01');
    expect(iso).toBe(new Date(2026, 9, 1).toISOString());
    expect(dateInputValue(iso!)).toBe('2026-10-01');
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('2026-13-45')).toBeNull();
  });

  it('explains Google access failures with the scope action', () => {
    expect(syncFailureText('delegation-not-authorized')).toContain('Add the device scopes');
    expect(syncFailureText('interrupted')).toBe('The last refresh stopped before it finished.');
    expect(syncFailureText(null)).toBe('');
    expect(telemetryFailureText('permission-denied')).toContain('Add the telemetry scope');
    expect(telemetryFailureText(null)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./device-fields`.

- [ ] **Step 4: Write the helpers**

Create `frontend/src/app/devices/device-fields.ts`:

```ts
import {
  batteryFilterValueSchema,
  type DeviceBattery,
  type DeviceOrgUnit,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceSyncFailure,
  type GoogleFailure,
} from '@campus/application-contracts';

export type DeviceSortField = DeviceQuery['sort']['field'];
export type BatteryFilterValue =
  (typeof batteryFilterValueSchema.options)[number];
export type DeviceFieldKind = 'text' | 'orgUnit' | 'battery' | 'date';

export interface DeviceField {
  id: DeviceSortField;
  label: string;
  kind: DeviceFieldKind;
  /** Optional columns start hidden in the grid. */
  optional: boolean;
}

export interface OrgUnitOption {
  path: string;
  label: string;
  depth: number;
}

/** Grid column and filter order from the field contract, without the School column. */
export const DEVICE_FIELDS: readonly DeviceField[] = [
  { id: 'serialNumber', label: 'Serial', kind: 'text', optional: false },
  { id: 'model', label: 'Model', kind: 'text', optional: false },
  { id: 'assetTag', label: 'Asset tag', kind: 'text', optional: false },
  { id: 'orgUnitPath', label: 'Organization unit', kind: 'orgUnit', optional: false },
  { id: 'battery', label: 'Battery', kind: 'battery', optional: false },
  { id: 'lastContact', label: 'Device contact', kind: 'date', optional: false },
  { id: 'annotatedLocation', label: 'Annotated location', kind: 'text', optional: true },
  { id: 'notes', label: 'Notes', kind: 'text', optional: true },
];

export const TEXT_OPERATORS = [
  { id: 'contains', label: 'Contains' },
  { id: 'startsWith', label: 'Starts with' },
  { id: 'equals', label: 'Is' },
  { id: 'isEmpty', label: 'Is empty' },
] as const;
export const DATE_OPERATORS = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'On or after' },
] as const;
export const ORG_UNIT_OPERATORS = [
  { id: 'within', label: 'Is within' },
  { id: 'equals', label: 'Is' },
] as const;

export const BATTERY_LABELS: Readonly<Record<BatteryFilterValue, string>> = {
  normal: 'Normal',
  'replace-soon': 'Replace soon',
  'replace-now': 'Replace now',
  'no-report': 'No battery report',
  unavailable: 'Unavailable',
};

export function fieldFor(id: DeviceSortField): DeviceField {
  const field = DEVICE_FIELDS.find((candidate) => candidate.id === id);
  if (!field) throw new Error(`Unknown device field ${id}`);
  return field;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function chipLabel(predicate: DevicePredicate): string {
  const label = fieldFor(predicate.field).label;
  if (predicate.field === 'battery')
    return `${label} · ${predicate.values.map((value) => BATTERY_LABELS[value]).join(', ')}`;
  if (predicate.field === 'orgUnitPath')
    return `${label} ${predicate.operator === 'within' ? 'is within' : 'is'}: ${predicate.value}`;
  if (predicate.field === 'lastContact')
    return `${label} ${predicate.operator === 'before' ? 'before' : 'on or after'}: ${day(predicate.value)}`;
  if (predicate.operator === 'isEmpty') return `${label} is empty`;
  const operator = TEXT_OPERATORS.find(
    (candidate) => candidate.id === predicate.operator,
  )!.label.toLowerCase();
  return `${label} ${operator}: ${predicate.value}`;
}

export function shortcutLabel(predicate: DevicePredicate): string {
  return 'value' in predicate
    ? `${fieldFor(predicate.field).label} contains "${predicate.value}"`
    : chipLabel(predicate);
}

/** GRID-04: field labels match first. Identifier shortcuts follow for any typed text. */
export function suggestions(text: string): {
  fields: DeviceField[];
  shortcuts: DevicePredicate[];
} {
  const query = text.trim();
  const lower = query.toLowerCase();
  return {
    fields: DEVICE_FIELDS.filter((field) =>
      field.label.toLowerCase().includes(lower),
    ),
    shortcuts:
      query && query.length <= 256
        ? [
            { field: 'assetTag', operator: 'contains', value: query },
            { field: 'serialNumber', operator: 'contains', value: query },
          ]
        : [],
  };
}

export function orgUnitOptions(
  units: readonly DeviceOrgUnit[],
  search = '',
): OrgUnitOption[] {
  const paths = new Set<string>(['/']);
  for (const unit of units) {
    const parts = unit.path.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++)
      paths.add(`/${parts.slice(0, index).join('/')}`);
  }
  const lower = search.trim().toLowerCase();
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .filter((path) => path.toLowerCase().includes(lower))
    .map((path) => {
      const parts = path.split('/').filter(Boolean);
      return {
        path,
        label: parts.at(-1) ?? 'All organization units',
        depth: parts.length,
      };
    });
}

export function batteryText(battery: DeviceBattery): string {
  return battery.status === 'reported'
    ? BATTERY_LABELS[battery.health]
    : BATTERY_LABELS[battery.status];
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function dateInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date filters start at local midnight of the chosen day. */
export function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, dayOfMonth] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, dayOfMonth);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === dayOfMonth
    ? date.toISOString()
    : null;
}

const accessFailures = new Set<string>([
  'delegation-not-authorized',
  'scope-mismatch',
  'permission-denied',
  'policy-restricted',
]);

export function syncFailureText(failure: DeviceSyncFailure | null): string {
  if (!failure) return '';
  if (accessFailures.has(failure))
    return 'Google denied device access. Add the device scopes to the delegation client in the Google Admin Console.';
  switch (failure) {
    case 'api-not-enabled':
      return 'Enable the Admin SDK API in the Google Cloud project of the service account.';
    case 'quota':
      return 'Google limited the requests. Refresh again later.';
    case 'network-failure':
    case 'provider-unavailable':
      return 'Campus Commander could not reach Google. Refresh again.';
    case 'credential-rejected':
    case 'key-unavailable':
      return 'The Google credential needs attention. Open the Google connection page.';
    case 'interrupted':
      return 'The last refresh stopped before it finished.';
    case 'orchestration-unavailable':
      return 'Campus Commander could not start the refresh. Check Diagnostics.';
    default:
      return 'The last refresh failed.';
  }
}

export function telemetryFailureText(
  failure: GoogleFailure | null,
): string | null {
  if (!failure) return null;
  return accessFailures.has(failure)
    ? 'Google denied battery telemetry access. Add the telemetry scope to the delegation client in the Google Admin Console.'
    : 'Campus Commander could not read battery telemetry during the last refresh.';
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm exec -- nx run-many -t test lint -p frontend --skip-nx-cache`
Expected: PASS, including the existing frontend specs.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json frontend/src/app/devices
git commit -m "feat: add device field helpers and the qualified grid packages"
```

---

### Task 3: Devices store

**Files:**
- Create: `frontend/src/app/devices/devices.store.ts`
- Create: `frontend/src/app/devices/devices.store.spec.ts`

**Interfaces:**
- Consumes: `AuthStore.request(path, body?) → Promise<Response>`, contract schemas, Task 2 nothing.
- Produces: `devicesReadable(auth) → boolean` and `@Injectable({ providedIn: 'root' }) class DevicesStore` with:
  - signals `sync`, `syncLoaded`, `predicates`, `sort`, `page`, `orgUnits`, `offline`, `error`, `revision`, `position`, `optionalColumns`; computed `refreshing`, `readable`; field `pollInterval` (milliseconds)
  - `init()`, `loadSync()`, `refreshAll()`, `reconnect()`, `rows(offset, limit) → Promise<DevicePage | null>`, `neighbor(index) → Promise<DeviceRow | null>`, `device(id) → Promise<DeviceDetail | null>`, `loadOrgUnits()`, `setPredicates(list)`, `setSort(sort)`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/devices/devices.store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';

const state = (status: string, extra: Record<string, unknown> = {}) => ({
  customerId: 'C0123456',
  generation: 1,
  status,
  observedAt: status === 'ready' ? '2026-10-05T12:00:00.000Z' : null,
  deviceCount: status === 'ready' ? 450 : 0,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});
const page = {
  rows: [],
  matching: 96,
  total: 450,
  observedAt: '2026-10-05T12:00:00.000Z',
};

function setup(request: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          metadata: () => ({ phase: 3 }),
          session: () => ({
            identity: {
              id: 'actor',
              permissionVersion: 1,
              grants: [{ action: 'devices:read', scope: { kind: 'platform' } }],
            },
            csrfToken: 'session',
          }),
          interrupted: () => false,
        },
      },
    ],
  });
  const store = TestBed.inject(DevicesStore);
  store.pollInterval = 0;
  return store;
}

it('queries rows with the active filters and sort and keeps the counts', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ page }));
  const store = setup(request);
  store.setPredicates([{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }]);
  store.setSort({ field: 'assetTag', direction: 'desc' });
  await store.rows(100, 100);
  expect(request).toHaveBeenCalledWith('/api/devices/query', {
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    offset: 100,
    limit: 100,
  });
  expect(store.page()).toEqual({ matching: 96, total: 450, observedAt: page.observedAt });
  expect(store.readable()).toBe(true);
});

it('keeps the last counts and reports offline when the network fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ page }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  await store.rows(0, 100);
  expect(await store.rows(100, 100)).toBeNull();
  expect(store.offline()).toBe(true);
  expect(store.page()?.matching).toBe(96);
  const before = store.revision();
  await store.reconnect();
  expect(store.offline()).toBe(false);
  expect(store.revision()).toBe(before + 1);
});

it('polls a refresh until it settles and reloads with the same filters', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sync: state('running') }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ sync: state('running') }))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  store.setPredicates([{ field: 'model', operator: 'contains', value: 'Lenovo' }]);
  const before = store.revision();
  await store.refreshAll();
  expect(request).toHaveBeenNthCalledWith(1, '/api/devices/sync', {});
  expect(store.sync()?.status).toBe('ready');
  expect(store.revision()).toBe(before + 1);
  expect(store.predicates()).toEqual([{ field: 'model', operator: 'contains', value: 'Lenovo' }]);
});

it('follows a refresh that is already running', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ reason: 'device-sync-running' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ sync: state('running') }))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  await store.refreshAll();
  expect(store.sync()?.status).toBe('ready');
  expect(store.error()).toBe('');
});

it('changing filters reloads the grid and forgets the row position', () => {
  const store = setup(vi.fn());
  store.position.set(4);
  const before = store.revision();
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.revision()).toBe(before + 1);
  expect(store.position()).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./devices.store`.

- [ ] **Step 3: Write the store**

Create `frontend/src/app/devices/devices.store.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import {
  deviceDetailSchema,
  deviceOrgUnitsSchema,
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DeviceOrgUnit,
  type DevicePage,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
  type DeviceSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

export type OptionalDeviceColumn = 'annotatedLocation' | 'notes';

export function devicesReadable(auth: InstanceType<typeof AuthStore>): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'devices:read')
  );
}

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  /** Milliseconds between sync status checks while a refresh runs. */
  pollInterval = 2000;
  readonly sync = signal<DeviceSyncState | null>(null);
  readonly syncLoaded = signal(false);
  readonly predicates = signal<DevicePredicate[]>([]);
  readonly sort = signal<DeviceQuery['sort']>({
    field: 'serialNumber',
    direction: 'asc',
  });
  readonly page = signal<Omit<DevicePage, 'rows'> | null>(null);
  readonly orgUnits = signal<DeviceOrgUnit[]>([]);
  readonly offline = signal(false);
  readonly error = signal('');
  /** Increments when the grid must reload from the first block. */
  readonly revision = signal(0);
  /** Row index of the last opened device in the current filtered order. */
  readonly position = signal<number | null>(null);
  readonly optionalColumns = signal<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly readable = computed(() => devicesReadable(this.auth));
  private polling = false;

  private async call(path: string, body?: unknown): Promise<Response | null> {
    try {
      const response = await this.auth.request(path, body);
      this.offline.set(false);
      return response;
    } catch {
      this.offline.set(true);
      return null;
    }
  }

  async init(): Promise<void> {
    await this.loadSync();
    if (this.refreshing()) await this.poll();
  }

  async loadSync(): Promise<void> {
    const response = await this.call('/api/devices/sync');
    if (!response) return;
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return;
    }
    this.error.set('');
    this.sync.set(
      deviceSyncStateSchema.nullable().parse((await response.json()).sync),
    );
    this.syncLoaded.set(true);
  }

  async refreshAll(): Promise<void> {
    const response = await this.call('/api/devices/sync', {});
    if (!response) return;
    const body = await response.json().catch(() => null);
    if (response.status === 409 && body?.reason === 'device-sync-running') {
      await this.loadSync();
    } else if (!response.ok) {
      this.error.set(
        body?.reason === 'orchestration-unavailable'
          ? 'Campus Commander could not start the refresh. Check Diagnostics.'
          : 'The refresh could not start.',
      );
      return;
    } else {
      this.error.set('');
      this.sync.set(deviceSyncStateSchema.parse(body.sync));
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      while (this.sync()?.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        await this.loadSync();
        if (this.offline()) return;
      }
      this.revision.update((value) => value + 1);
    } finally {
      this.polling = false;
    }
  }

  async reconnect(): Promise<void> {
    await this.loadSync();
    if (!this.offline()) this.revision.update((value) => value + 1);
  }

  async rows(offset: number, limit: number): Promise<DevicePage | null> {
    const response = await this.call('/api/devices/query', {
      predicates: this.predicates(),
      sort: this.sort(),
      offset,
      limit,
    });
    if (!response?.ok) return null;
    const page = devicePageSchema.parse((await response.json()).page);
    this.page.set({
      matching: page.matching,
      total: page.total,
      observedAt: page.observedAt,
    });
    return page;
  }

  async neighbor(index: number): Promise<DeviceRow | null> {
    if (index < 0) return null;
    return (await this.rows(index, 1))?.rows[0] ?? null;
  }

  async device(id: string): Promise<DeviceDetail | null> {
    const response = await this.call(`/api/devices/${encodeURIComponent(id)}`);
    if (!response?.ok) return null;
    return deviceDetailSchema.parse((await response.json()).device);
  }

  async loadOrgUnits(): Promise<void> {
    const response = await this.call('/api/devices/org-units');
    if (!response?.ok) return;
    this.orgUnits.set(
      deviceOrgUnitsSchema.parse((await response.json()).orgUnits),
    );
  }

  setPredicates(predicates: DevicePredicate[]): void {
    this.predicates.set(predicates);
    this.position.set(null);
    this.revision.update((value) => value + 1);
  }

  /** The grid calls this when a header sort changes. The grid reloads itself. */
  setSort(sort: DeviceQuery['sort']): void {
    const current = this.sort();
    if (current.field === sort.field && current.direction === sort.direction)
      return;
    this.sort.set(sort);
    this.position.set(null);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm exec -- nx run-many -t test lint -p frontend --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: keep device browsing state in a shared store"
```

---

### Task 4: Device grid

**Files:**
- Create: `frontend/src/app/devices/device-details-cell.ts`
- Create: `frontend/src/app/devices/device-columns.ts`
- Create: `frontend/src/app/devices/device-datasource.ts`
- Create: `frontend/src/app/devices/device-grid.ts`
- Create: `frontend/src/app/devices/device-grid.spec.ts`

**Interfaces:**
- Consumes: `DEVICE_FIELDS`, `batteryText`, `relativeTime` (Task 2).
- Produces:
  - `deviceColumnDefs(onDetails: (row: DeviceRow, index: number) => void, now?: () => number): ColDef<DeviceRow>[]`
  - `type DeviceSort = DeviceQuery['sort']`, `sortFromModel(model) → DeviceSort`, `deviceDatasource(load) → IServerSideDatasource<DeviceRow>` where `load(offset, limit, sort) → Promise<DevicePage | null>`
  - component `app-device-grid` (`DeviceGrid`) with inputs `load` (required), `revision`, `optionalColumns`, `focusIndex`, and outputs `details: { row: DeviceRow; index: number }` and `rangeChange: DeviceRange | null`, where `DeviceRange = { first: number; last: number }`

AG Grid renders poorly in jsdom. The unit tests cover the column definitions and the datasource adapter. The Task 8 browser check covers the rendered grid.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/devices/device-grid.spec.ts`:

```ts
import type { IServerSideGetRowsParams } from 'ag-grid-community';
import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';
import { deviceDatasource, sortFromModel } from './device-datasource';

const row: DeviceRow = {
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-0001',
  model: 'Lenovo 100e Gen 4',
  assetTag: 'HS-0401',
  orgUnitPath: '/School A',
  lastContact: '2026-10-05T11:58:00Z',
  annotatedLocation: null,
  notes: null,
  battery: { status: 'reported', health: 'replace-soon', capacityPercent: 78, reportedAt: '2026-10-05T11:00:00Z' },
};
type Getter = (params: { data: DeviceRow }) => unknown;

it('orders columns after the details icon and hides optional fields', () => {
  const columns = deviceColumnDefs(() => undefined, () => Date.parse('2026-10-05T12:00:00Z'));
  expect(columns.map((column) => column.colId)).toEqual([
    'details', 'serialNumber', 'model', 'assetTag', 'orgUnitPath', 'battery', 'lastContact', 'annotatedLocation', 'notes',
  ]);
  expect(columns[0].pinned).toBe('left');
  expect(columns.filter((column) => column.hide).map((column) => column.colId)).toEqual(['annotatedLocation', 'notes']);
  const value = (id: string) => (columns.find((column) => column.colId === id)!.valueGetter as Getter)({ data: row });
  expect(value('battery')).toBe('Replace soon');
  expect(value('lastContact')).toBe('2 min ago');
  expect(value('notes')).toBe('');
});

it('loads grid blocks from the device query with the header sort', async () => {
  const load = vi.fn().mockResolvedValue({ rows: [row], matching: 96, total: 450, observedAt: null });
  const success = vi.fn();
  const fail = vi.fn();
  deviceDatasource(load).getRows({
    request: { startRow: 100, endRow: 200, sortModel: [{ colId: 'assetTag', sort: 'desc' }] },
    success,
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(load).toHaveBeenCalledWith(100, 100, { field: 'assetTag', direction: 'desc' });
  expect(success).toHaveBeenCalledWith({ rowData: [row], rowCount: 96 });
  expect(fail).not.toHaveBeenCalled();
});

it('fails the block when the query fails', async () => {
  const fail = vi.fn();
  deviceDatasource(vi.fn().mockResolvedValue(null)).getRows({
    request: { startRow: 0, endRow: 100, sortModel: [] },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(fail).toHaveBeenCalled());
});

it('falls back to serial order for columns without a query field', () => {
  expect(sortFromModel([{ colId: 'details', sort: 'asc' }])).toEqual({ field: 'serialNumber', direction: 'asc' });
  expect(sortFromModel(undefined)).toEqual({ field: 'serialNumber', direction: 'asc' });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./device-columns`.

- [ ] **Step 3: Write the details cell, columns, and datasource**

Create `frontend/src/app/devices/device-details-cell.ts`:

```ts
import { Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';

export interface DeviceDetailsCellParams extends ICellRendererParams<DeviceRow> {
  onDetails(row: DeviceRow, index: number): void;
}

/** GRID-03 details icon. Selection and editing stay separate from detail navigation. */
@Component({
  selector: 'app-device-details-cell',
  template: `
    <button
      type="button"
      class="details-action"
      [attr.aria-label]="label()"
      [attr.title]="label()"
      (click)="activate()"
    >
      <span class="material-symbols-outlined" aria-hidden="true">visibility</span>
    </button>
  `,
  styles: `
    .details-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--cc-text-link);
      cursor: pointer;
    }
  `,
})
export class DeviceDetailsCell implements ICellRendererAngularComp {
  private readonly params = signal<DeviceDetailsCellParams | null>(null);
  protected readonly label = computed(() => {
    const data = this.params()?.data;
    return data ? `Open details for ${data.serialNumber || data.deviceId}` : 'Open details';
  });

  agInit(params: DeviceDetailsCellParams): void {
    this.params.set(params);
  }

  refresh(params: DeviceDetailsCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected activate(): void {
    const params = this.params();
    if (params?.data && params.node.rowIndex !== null)
      params.onDetails(params.data, params.node.rowIndex);
  }
}
```

Create `frontend/src/app/devices/device-columns.ts`:

```ts
import type { ColDef } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import {
  DEVICE_FIELDS,
  batteryText,
  relativeTime,
  type DeviceSortField,
} from './device-fields';
import { DeviceDetailsCell } from './device-details-cell';

function value(row: DeviceRow, field: DeviceSortField, now: number): string {
  switch (field) {
    case 'serialNumber':
      return row.serialNumber;
    case 'model':
      return row.model ?? '';
    case 'assetTag':
      return row.assetTag ?? '';
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'battery':
      return batteryText(row.battery);
    case 'lastContact':
      return relativeTime(row.lastContact, now);
    case 'annotatedLocation':
      return row.annotatedLocation ?? '';
    case 'notes':
      return row.notes ?? '';
  }
}

/** Every data column is read-only in this slice (GRID-05). */
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, index: number) => void,
  now: () => number = Date.now,
): ColDef<DeviceRow>[] {
  return [
    {
      colId: 'details',
      headerName: 'Details',
      headerClass: 'device-details-header',
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      pinned: 'left',
      lockVisible: true,
      suppressMovable: true,
      sortable: false,
      resizable: false,
      cellRenderer: DeviceDetailsCell,
      cellRendererParams: { onDetails },
    },
    ...DEVICE_FIELDS.map(
      (field): ColDef<DeviceRow> => ({
        colId: field.id,
        headerName: field.label,
        valueGetter: ({ data }) => (data ? value(data, field.id, now()) : ''),
        sortable: true,
        hide: field.optional,
        cellClass: field.id === 'serialNumber' ? 'device-code' : undefined,
      }),
    ),
  ];
}
```

Create `frontend/src/app/devices/device-datasource.ts`:

```ts
import type {
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import type {
  DevicePage,
  DeviceQuery,
  DeviceRow,
} from '@campus/application-contracts';
import { DEVICE_FIELDS } from './device-fields';

export type DeviceSort = DeviceQuery['sort'];
export type DeviceLoader = (
  offset: number,
  limit: number,
  sort: DeviceSort,
) => Promise<DevicePage | null>;

const defaultSort: DeviceSort = { field: 'serialNumber', direction: 'asc' };

export function sortFromModel(
  model: readonly { colId: string; sort: 'asc' | 'desc' }[] | undefined,
): DeviceSort {
  const first = model?.[0];
  const field = DEVICE_FIELDS.find((candidate) => candidate.id === first?.colId);
  return field && first ? { field: field.id, direction: first.sort } : defaultSort;
}

/** Adapt LibreGrid block requests to the device query endpoint (GRID-01). */
export function deviceDatasource(
  load: DeviceLoader,
): IServerSideDatasource<DeviceRow> {
  return {
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      const offset = params.request.startRow ?? 0;
      const limit = Math.min(
        200,
        Math.max(1, (params.request.endRow ?? offset + 100) - offset),
      );
      load(offset, limit, sortFromModel(params.request.sortModel)).then(
        (page) =>
          page
            ? params.success({ rowData: page.rows, rowCount: page.matching })
            : params.fail(),
        () => params.fail(),
      );
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Write the grid component**

Create `frontend/src/app/devices/device-grid.ts`. The `ModuleRegistry` call lives in this file, so the vendor modules load with the lazily loaded Devices route (GRID-02).

```ts
import { Component, effect, input, output, untracked } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
} from 'ag-grid-community';
import { ServerSideRowModelModule } from '@libregrid/server-side-row-model';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';
import { deviceDatasource, type DeviceLoader } from './device-datasource';
import type { OptionalDeviceColumn } from './devices.store';

ModuleRegistry.registerModules([AllCommunityModule, ServerSideRowModelModule]);

export interface DeviceRange {
  first: number;
  last: number;
}

@Component({
  selector: 'app-device-grid',
  imports: [AgGridAngular],
  template: `
    <ag-grid-angular
      class="device-grid"
      [gridOptions]="options"
      (gridReady)="ready($event)"
      (modelUpdated)="updated()"
      (bodyScrollEnd)="emitRange()"
    />
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: calc(var(--cc-row-height-grid) * 8);
    }
    .device-grid {
      display: block;
      height: 100%;
    }
    :host ::ng-deep .device-code {
      font-family: 'Roboto Mono', monospace;
    }
    :host ::ng-deep .device-details-header .ag-header-cell-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `,
})
export class DeviceGrid {
  readonly load = input.required<DeviceLoader>();
  readonly revision = input(0);
  readonly optionalColumns = input<Record<OptionalDeviceColumn, boolean>>({
    annotatedLocation: false,
    notes: false,
  });
  /** Row to scroll into view after the first block loads, such as after Back to devices. */
  readonly focusIndex = input<number | null>(null);
  readonly details = output<{ row: DeviceRow; index: number }>();
  readonly rangeChange = output<DeviceRange | null>();

  private api: GridApi<DeviceRow> | null = null;
  private focused = false;
  protected readonly options: GridOptions<DeviceRow> = {
    theme: themeQuartz.withParams({
      accentColor: 'var(--cc-accent)',
      backgroundColor: 'var(--cc-surface-card)',
      headerBackgroundColor: 'var(--cc-surface-app)',
      borderColor: 'var(--cc-border)',
      foregroundColor: 'var(--cc-text-primary)',
    }),
    columnDefs: deviceColumnDefs((row, index) =>
      this.details.emit({ row, index }),
    ),
    getRowId: ({ data }) => data.deviceId,
    rowModelType: 'serverSide',
    cacheBlockSize: 100,
    maxBlocksInCache: 20,
  };

  constructor() {
    effect(() => {
      this.revision();
      untracked(() => this.reload());
    });
    effect(() => {
      const columns = this.optionalColumns();
      untracked(() => this.applyColumns(columns));
    });
  }

  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    this.applyColumns(this.optionalColumns());
    this.reload();
  }

  /** Setting a new datasource resets the server-side row model to its first block. */
  private reload(): void {
    this.api?.setGridOption(
      'serverSideDatasource',
      deviceDatasource((offset, limit, sort) => this.load()(offset, limit, sort)),
    );
  }

  private applyColumns(columns: Record<OptionalDeviceColumn, boolean>): void {
    this.api?.setColumnsVisible(['annotatedLocation'], columns.annotatedLocation);
    this.api?.setColumnsVisible(['notes'], columns.notes);
  }

  protected updated(): void {
    const index = this.focusIndex();
    if (!this.focused && index !== null && this.api && this.api.getDisplayedRowCount() > 0) {
      this.focused = true;
      this.api.ensureIndexVisible(index, 'middle');
    }
    this.emitRange();
  }

  protected emitRange(): void {
    const api = this.api;
    if (!api) return;
    const first = api.getFirstDisplayedRowIndex();
    const last = api.getLastDisplayedRowIndex();
    this.rangeChange.emit(first >= 0 && last >= first ? { first, last } : null);
  }
}
```

- [ ] **Step 6: Build and test**

Run: `npm exec -- nx run-many -t build test lint -p frontend --skip-nx-cache`
Expected: PASS. The production build compiles the grid component and its vendor imports.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: render devices in a LibreGrid server-side grid"
```

---

### Task 5: Typed device filter

**Files:**
- Create: `frontend/src/app/devices/device-filter.ts`
- Create: `frontend/src/app/devices/device-filter.html`
- Create: `frontend/src/app/devices/device-filter.css`
- Create: `frontend/src/app/devices/device-filter.spec.ts`

**Interfaces:**
- Consumes: Task 2 helpers. `devicePredicateSchema` from contracts.
- Produces: component `app-device-filter` (`DeviceFilter`) with inputs `orgUnits: readonly DeviceOrgUnit[]` and `editing: DevicePredicate | null`, and outputs `applied: DevicePredicate` and `closed: void`. It renders the dashed Add a filter control, the combobox, and the typed editor.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/devices/device-filter.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import type { DeviceOrgUnit, DevicePredicate } from '@campus/application-contracts';
import { DeviceFilter } from './device-filter';

function setup(orgUnits: DeviceOrgUnit[] = []) {
  const fixture = TestBed.createComponent(DeviceFilter);
  fixture.componentRef.setInput('orgUnits', orgUnits);
  const applied: DevicePredicate[] = [];
  let closed = 0;
  fixture.componentInstance.applied.subscribe((predicate) => applied.push(predicate));
  fixture.componentInstance.closed.subscribe(() => closed++);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const render = () => fixture.detectChanges();
  const type = (selector: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    render();
  };
  const click = (target: Element | null) => {
    (target as HTMLElement).click();
    render();
  };
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name)!;
  const options = () =>
    [...element.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim());
  const start = (text: string) => {
    click(element.querySelector('.add-filter'));
    type('[role="combobox"]', text);
  };
  return { element, applied, closed: () => closed, type, click, button, options, start, render };
}

it('lists matched fields before shortcut matches', () => {
  const { element, options, start } = setup();
  start('asset');
  expect([...element.querySelectorAll('.group-label')].map((label) => label.textContent?.trim())).toEqual([
    'Matched fields',
    'Shortcut matches',
  ]);
  expect(options()).toEqual(['Asset tag', 'Asset tag contains "asset"', 'Serial contains "asset"']);
});

it('opens a prefilled editor for a shortcut and applies only on Apply', () => {
  const { element, applied, click, button, start } = setup();
  start('HS-04');
  click(element.querySelectorAll('[role="option"]')[0]);
  expect(applied).toEqual([]);
  expect(element.querySelector('h2')?.textContent?.trim()).toBe('Asset tag');
  expect(element.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('HS-04');
  click(button('Apply'));
  expect(applied).toEqual([{ field: 'assetTag', operator: 'contains', value: 'HS-04' }]);
  expect(element.querySelector('.add-filter')).not.toBeNull();
});

it('keeps Apply disabled for blank text', () => {
  const { element, type, click, button, start } = setup();
  start('serial');
  click(element.querySelectorAll('[role="option"]')[0]);
  type('input[type="text"]', '   ');
  expect(button('Apply').disabled).toBe(true);
});

it('selects suggestions with the keyboard', () => {
  const { element, applied, click, button, start, render } = setup();
  start('asset');
  const combobox = element.querySelector<HTMLInputElement>('[role="combobox"]')!;
  combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  render();
  expect(combobox.getAttribute('aria-activedescendant')).toBe(element.querySelectorAll('[role="option"]')[1].id);
  combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  render();
  click(button('Apply'));
  expect(applied).toEqual([{ field: 'assetTag', operator: 'contains', value: 'asset' }]);
});

it('applies the chosen battery classes', () => {
  const { element, applied, click, button, start } = setup();
  start('batt');
  click(element.querySelectorAll('[role="option"]')[0]);
  const box = (label: string) =>
    [...element.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === label)!.querySelector('input');
  click(box('Replace soon'));
  click(box('No battery report'));
  click(button('Apply'));
  expect(applied).toEqual([{ field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] }]);
});

it('applies an organization unit including its descendants', () => {
  const { element, applied, click, button, start } = setup([{ path: '/School A/Library', devices: 3 }]);
  start('organ');
  click(element.querySelectorAll('[role="option"]')[0]);
  const labels = [...element.querySelectorAll('.unit')].map((unit) => unit.textContent?.trim());
  expect(labels).toEqual(['All organization units', 'School A', 'Library']);
  expect(element.textContent).toContain('Includes descendant organization units.');
  click(element.querySelectorAll('.unit input')[1]);
  click(button('Apply'));
  expect(applied).toEqual([{ field: 'orgUnitPath', operator: 'within', value: '/School A' }]);
});

it('closes on Escape without applying', () => {
  const { element, applied, closed, start, render } = setup();
  start('model');
  element.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  render();
  expect(applied).toEqual([]);
  expect(closed()).toBe(1);
  expect(element.querySelector('[role="combobox"]')).toBeNull();
  expect(element.querySelector('.add-filter')).not.toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./device-filter`.

- [ ] **Step 3: Write the component**

Create `frontend/src/app/devices/device-filter.ts`:

```ts
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  devicePredicateSchema,
  type DeviceOrgUnit,
  type DevicePredicate,
} from '@campus/application-contracts';
import {
  BATTERY_LABELS,
  DATE_OPERATORS,
  ORG_UNIT_OPERATORS,
  TEXT_OPERATORS,
  dateInputToIso,
  dateInputValue,
  fieldFor,
  orgUnitOptions,
  shortcutLabel,
  suggestions,
  type BatteryFilterValue,
  type DeviceField,
} from './device-fields';

interface Suggestion {
  id: string;
  label: string;
  field: DeviceField;
  predicate: DevicePredicate | null;
}

let nextId = 0;

/** GRID-04 filter entry: field autocomplete, shortcut matches, and typed editors with explicit Apply. */
@Component({
  selector: 'app-device-filter',
  imports: [MatButtonModule],
  templateUrl: './device-filter.html',
  styleUrl: './device-filter.css',
})
export class DeviceFilter {
  readonly orgUnits = input<readonly DeviceOrgUnit[]>([]);
  readonly editing = input<DevicePredicate | null>(null);
  readonly applied = output<DevicePredicate>();
  readonly closed = output<void>();

  private readonly injector = inject(Injector);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entry = viewChild<ElementRef<HTMLInputElement>>('entry');
  protected readonly id = `device-filter-${++nextId}`;
  protected readonly entering = signal(false);
  protected readonly text = signal('');
  protected readonly active = signal(0);
  protected readonly field = signal<DeviceField | null>(null);
  protected readonly operator = signal('contains');
  protected readonly value = signal('');
  protected readonly battery = signal<readonly BatteryFilterValue[]>([]);
  protected readonly unitSearch = signal('');
  protected readonly textOperators = TEXT_OPERATORS;
  protected readonly dateOperators = DATE_OPERATORS;
  protected readonly orgUnitOperators = ORG_UNIT_OPERATORS;
  protected readonly batteryOptions = Object.entries(BATTERY_LABELS) as [
    BatteryFilterValue,
    string,
  ][];

  protected readonly suggestions = computed<Suggestion[]>(() => {
    const { fields, shortcuts } = suggestions(this.text());
    return [
      ...fields.map((field) => ({
        id: `${this.id}-field-${field.id}`,
        label: field.label,
        field,
        predicate: null,
      })),
      ...shortcuts.map((predicate, index) => ({
        id: `${this.id}-shortcut-${index}`,
        label: shortcutLabel(predicate),
        field: fieldFor(predicate.field),
        predicate,
      })),
    ];
  });
  /** Empty sections are suppressed (GRID-04). */
  protected readonly groups = computed(() =>
    [
      { name: 'Matched fields', items: this.suggestions().filter((item) => !item.predicate) },
      { name: 'Shortcut matches', items: this.suggestions().filter((item) => item.predicate) },
    ].filter((group) => group.items.length > 0),
  );
  protected readonly activeId = computed(
    () => this.suggestions()[this.active()]?.id ?? null,
  );
  protected readonly units = computed(() =>
    orgUnitOptions(this.orgUnits(), this.unitSearch()),
  );
  protected readonly draft = computed<DevicePredicate | null>(() => {
    const field = this.field();
    if (!field) return null;
    const candidate =
      field.kind === 'battery'
        ? { field: field.id, operator: 'is', values: this.battery() }
        : field.kind === 'date'
          ? { field: field.id, operator: this.operator(), value: dateInputToIso(this.value()) }
          : this.operator() === 'isEmpty'
            ? { field: field.id, operator: 'isEmpty' }
            : { field: field.id, operator: this.operator(), value: this.value() };
    const parsed = devicePredicateSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  });

  constructor() {
    effect(() => {
      const predicate = this.editing();
      if (predicate) untracked(() => this.open(predicate));
    });
  }

  protected start(): void {
    this.entering.set(true);
    this.text.set('');
    this.active.set(0);
    afterNextRender(() => this.entry()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected typed(value: string): void {
    this.text.set(value);
    this.active.set(0);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.suggestions().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.active.set((this.active() + step + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = this.suggestions()[this.active()];
      if (choice) this.choose(choice);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  protected choose(choice: Suggestion): void {
    this.entering.set(false);
    if (choice.predicate) this.open(choice.predicate);
    else this.openField(choice.field);
  }

  private openField(field: DeviceField): void {
    this.field.set(field);
    this.operator.set(
      field.kind === 'orgUnit' ? 'within' : field.kind === 'date' ? 'before' : 'contains',
    );
    this.value.set('');
    this.battery.set([]);
    this.unitSearch.set('');
  }

  private open(predicate: DevicePredicate): void {
    this.entering.set(false);
    this.openField(fieldFor(predicate.field));
    this.operator.set(predicate.operator);
    if (predicate.field === 'battery') this.battery.set(predicate.values);
    else if (predicate.field === 'lastContact')
      this.value.set(dateInputValue(predicate.value));
    else if ('value' in predicate) this.value.set(predicate.value);
  }

  protected toggleBattery(value: BatteryFilterValue, checked: boolean): void {
    this.battery.update((values) =>
      checked
        ? [...values.filter((item) => item !== value), value]
        : values.filter((item) => item !== value),
    );
  }

  protected apply(): void {
    const draft = this.draft();
    if (!draft) return;
    this.applied.emit(draft);
    this.close();
  }

  protected close(): void {
    this.entering.set(false);
    this.field.set(null);
    this.closed.emit();
    afterNextRender(() => this.trigger()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
```

Create `frontend/src/app/devices/device-filter.html`:

```html
@if (field(); as current) {
<section
  class="editor card"
  role="dialog"
  [attr.aria-labelledby]="id + '-title'"
  (keydown.escape)="close()"
>
  <h2 [id]="id + '-title'">{{ current.label }}</h2>
  @switch (current.kind) { @case ('battery') {
  <fieldset>
    <legend>Battery health</legend>
    @for (option of batteryOptions; track option[0]) {
    <label class="check"
      ><input
        type="checkbox"
        [checked]="battery().includes(option[0])"
        (change)="toggleBattery(option[0], $any($event.target).checked)"
      />{{ option[1] }}</label
    >
    }
  </fieldset>
  } @case ('orgUnit') {
  <label class="field"
    >Operator
    <select [value]="operator()" (change)="operator.set($any($event.target).value)">
      @for (item of orgUnitOperators; track item.id) {
      <option [value]="item.id">{{ item.label }}</option>
      }
    </select></label
  >
  <label class="field"
    >Find an organization unit
    <input
      type="search"
      [value]="unitSearch()"
      (input)="unitSearch.set($any($event.target).value)"
  /></label>
  <div class="units" role="radiogroup" aria-label="Organization unit">
    @for (unit of units(); track unit.path) {
    <label class="unit" [style.padding-inline-start.px]="unit.depth * 16"
      ><input
        type="radio"
        [name]="id + '-unit'"
        [checked]="value() === unit.path"
        (change)="value.set(unit.path)"
      />{{ unit.label }}</label
    >
    } @empty {
    <p>No organization units match.</p>
    }
  </div>
  @if (operator() === 'within') {
  <p class="hint">Includes descendant organization units.</p>
  } } @case ('date') {
  <label class="field"
    >Operator
    <select [value]="operator()" (change)="operator.set($any($event.target).value)">
      @for (item of dateOperators; track item.id) {
      <option [value]="item.id">{{ item.label }}</option>
      }
    </select></label
  >
  <label class="field"
    >Date
    <input
      type="date"
      [value]="value()"
      (input)="value.set($any($event.target).value)"
  /></label>
  } @default {
  <label class="field"
    >Operator
    <select [value]="operator()" (change)="operator.set($any($event.target).value)">
      @for (item of textOperators; track item.id) {
      <option [value]="item.id">{{ item.label }}</option>
      }
    </select></label
  >
  @if (operator() !== 'isEmpty') {
  <label class="field"
    >Value
    <input
      type="text"
      maxlength="256"
      [value]="value()"
      (input)="value.set($any($event.target).value)"
  /></label>
  } } }
  <div class="editor-actions">
    <button mat-button type="button" (click)="close()">Cancel</button>
    <button mat-flat-button type="button" [disabled]="!draft()" (click)="apply()">
      Apply
    </button>
  </div>
</section>
} @else if (entering()) {
<div class="entry">
  <input
    #entry
    type="text"
    role="combobox"
    aria-label="Filter field"
    aria-autocomplete="list"
    [attr.aria-expanded]="suggestions().length > 0"
    [attr.aria-controls]="id + '-list'"
    [attr.aria-activedescendant]="activeId()"
    [value]="text()"
    (input)="typed($any($event.target).value)"
    (keydown)="keydown($event)"
  />
  <div class="suggestions card" [id]="id + '-list'" role="listbox" aria-label="Filter suggestions">
    @for (group of groups(); track group.name) {
    <div role="group" [attr.aria-label]="group.name">
      <p class="group-label" aria-hidden="true">{{ group.name }}</p>
      @for (choice of group.items; track choice.id) {
      <div
        role="option"
        [id]="choice.id"
        [attr.aria-selected]="choice.id === activeId()"
        [class.active]="choice.id === activeId()"
        (mousedown)="$event.preventDefault()"
        (click)="choose(choice)"
      >
        {{ choice.label }}
      </div>
      }
    </div>
    }
  </div>
  <p class="visually-hidden" aria-live="polite">
    {{ suggestions().length }} suggestions
  </p>
</div>
} @else {
<button #trigger type="button" class="add-filter" (click)="start()">
  <span class="material-symbols-outlined" aria-hidden="true">add</span>
  Add a filter
</button>
}
```

Create `frontend/src/app/devices/device-filter.css`:

```css
:host {
  position: relative;
  display: inline-block;
}
.add-filter {
  display: inline-flex;
  align-items: center;
  gap: var(--cc-space-xs);
  min-height: 32px;
  padding-inline: var(--cc-space-md);
  border: 1px dashed var(--cc-border-control);
  border-radius: var(--cc-radius-chip);
  background: transparent;
  color: var(--cc-text-secondary);
  cursor: pointer;
}
.entry input[role='combobox'] {
  min-height: 32px;
  min-width: 240px;
  padding-inline: var(--cc-space-sm);
  border: 2px solid var(--cc-accent);
  border-radius: var(--cc-radius-control);
}
.suggestions,
.editor {
  position: absolute;
  z-index: 10;
  inset-block-start: calc(100% + var(--cc-space-xs));
  inset-inline-start: 0;
  min-width: 320px;
  max-height: 420px;
  overflow: auto;
}
.group-label {
  margin: var(--cc-space-sm) 0 var(--cc-space-xs);
  color: var(--cc-text-secondary);
  font-size: 12px;
  text-transform: uppercase;
}
[role='option'] {
  padding: var(--cc-space-sm);
  cursor: pointer;
}
[role='option'].active {
  background: var(--cc-surface-selected);
}
.editor h2 {
  margin-block-start: 0;
  font-size: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-xs);
  margin-block-end: var(--cc-space-md);
}
.field select,
.field input {
  min-height: 40px;
  padding-inline: var(--cc-space-sm);
}
.check,
.unit {
  display: flex;
  align-items: center;
  gap: var(--cc-space-sm);
  min-height: 32px;
}
.units {
  max-height: 220px;
  overflow: auto;
}
.hint {
  color: var(--cc-text-secondary);
}
.editor-actions {
  display: flex;
  gap: var(--cc-space-sm);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm exec -- nx run-many -t test lint -p frontend --skip-nx-cache`
Expected: PASS for all seven filter tests and the existing specs.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: add typed device filters with field and shortcut matches"
```

---

### Task 6: Devices page, route, and navigation

**Files:**
- Create: `frontend/src/app/devices/devices.ts`
- Create: `frontend/src/app/devices/devices.html`
- Create: `frontend/src/app/devices/devices.css`
- Create: `frontend/src/app/devices/devices.spec.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Modify: `frontend/src/app/shell/shell.ts`
- Modify: `frontend/src/app/shell/shell.html`

**Interfaces:**
- Consumes: `DevicesStore` (Task 3), `DeviceGrid` and `DeviceRange` (Task 4), `DeviceFilter` (Task 5), and `chipLabel`, `syncFailureText`, `telemetryFailureText` (Task 2).
- Produces: route `/devices` showing `DevicesPage` (`app-devices`), guarded by `devicesReadable`, and a Devices navigation link.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/devices/devices.spec.ts`. It replaces the grid with a stub and the store with signals, so it tests page states only.

```ts
import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { DevicePredicate, DeviceSyncState } from '@campus/application-contracts';
import { DeviceGrid } from './device-grid';
import { DevicesPage } from './devices';
import { DevicesStore } from './devices.store';

@Component({ selector: 'app-device-grid', template: '<p class="grid-stub">grid</p>' })
class GridStub {
  readonly load = input<unknown>();
  readonly revision = input(0);
  readonly optionalColumns = input<unknown>();
  readonly focusIndex = input<number | null>(null);
  readonly details = output<unknown>();
  readonly rangeChange = output<unknown>();
}

const ready = (extra: Partial<DeviceSyncState> = {}): DeviceSyncState => ({
  customerId: 'C0123456',
  generation: 1,
  status: 'ready',
  observedAt: '2026-10-05T12:00:00.000Z',
  deviceCount: 450,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});

function setup(options: {
  sync: DeviceSyncState | null;
  predicates?: DevicePredicate[];
  page?: { matching: number; total: number; observedAt: string | null } | null;
  offline?: boolean;
}) {
  const sync = signal(options.sync);
  const store = {
    sync,
    syncLoaded: signal(true),
    predicates: signal(options.predicates ?? []),
    page: signal(options.page ?? null),
    orgUnits: signal([]),
    offline: signal(options.offline ?? false),
    error: signal(''),
    revision: signal(0),
    position: signal<number | null>(null),
    optionalColumns: signal({ annotatedLocation: false, notes: false }),
    refreshing: computed(() => sync()?.status === 'running'),
    init: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setPredicates: vi.fn(),
    setSort: vi.fn(),
    rows: vi.fn(),
    loadOrgUnits: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DevicesStore, useValue: store }],
  });
  TestBed.overrideComponent(DevicesPage, {
    remove: { imports: [DeviceGrid] },
    add: { imports: [GridStub] },
  });
  const fixture = TestBed.createComponent(DevicesPage);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  return { store, element, button, render: () => fixture.detectChanges() };
}

it('offers Refresh inventory before the first sync', () => {
  const { store, element, button } = setup({ sync: ready({ status: 'never', observedAt: null, deviceCount: 0 }) });
  expect(element.textContent).toContain('No device inventory yet');
  button('Refresh inventory')!.click();
  expect(store.refreshAll).toHaveBeenCalled();
  expect(element.querySelector('.grid-stub')).toBeNull();
});

it('shows the stale banner with the failure cause', () => {
  const { element, button } = setup({
    sync: ready({ status: 'failed', failure: 'permission-denied', stale: true }),
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('Inventory observation is stale');
  expect(element.textContent).toContain('Add the device scopes');
  expect(button('Refresh inventory')).toBeDefined();
  expect(element.querySelector('.grid-stub')).not.toBeNull();
});

it('keeps the grid and offers Reconnect while offline', () => {
  const { store, element, button } = setup({
    sync: ready(),
    offline: true,
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.querySelector('.grid-stub')).not.toBeNull();
  button('Reconnect')!.click();
  expect(store.reconnect).toHaveBeenCalled();
});

it('renders filter chips and clears them', () => {
  const { store, button } = setup({
    sync: ready(),
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    page: { matching: 96, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(button('Asset tag starts with: HS-04')).toBeDefined();
  button('Clear filters')!.click();
  expect(store.setPredicates).toHaveBeenCalledWith([]);
});

it('shows counts and the observation time in the footer', () => {
  const { element } = setup({
    sync: ready(),
    page: { matching: 1234, total: 128431, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.querySelector('.grid-footer')?.textContent).toContain('1,234 matching devices · 128,431 in district');
  expect(element.querySelector('.grid-footer')?.textContent).toContain('Inventory observed');
});

it('shows no matches when filters exclude every device', () => {
  const { element } = setup({
    sync: ready(),
    predicates: [{ field: 'serialNumber', operator: 'equals', value: 'ZZ-NOT-FOUND' }],
    page: { matching: 0, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('No devices match these filters');
  expect(element.textContent).toContain('Check the serial or asset tag, or clear the current filters.');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./devices`.

- [ ] **Step 3: Write the page**

Create `frontend/src/app/devices/devices.ts`:

```ts
import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';
import { DevicesStore, type OptionalDeviceColumn } from './devices.store';
import { DeviceGrid, type DeviceRange } from './device-grid';
import { DeviceFilter } from './device-filter';
import type { DeviceSort } from './device-datasource';
import {
  chipLabel,
  syncFailureText,
  telemetryFailureText,
} from './device-fields';

@Component({
  selector: 'app-devices',
  imports: [DatePipe, RouterLink, MatButtonModule, MatMenuModule, DeviceGrid, DeviceFilter],
  templateUrl: './devices.html',
  styleUrl: './devices.css',
})
export class DevicesPage implements OnInit {
  protected readonly store = inject(DevicesStore);
  private readonly router = inject(Router);
  protected readonly sync = this.store.sync;
  protected readonly range = signal<DeviceRange | null>(null);
  protected readonly editingIndex = signal<number | null>(null);
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.store.predicates()[index] ?? null);
  });
  protected readonly published = computed(() => !!this.sync()?.observedAt);
  protected readonly noMatches = computed(
    () => this.store.page()?.matching === 0 && this.store.predicates().length > 0,
  );
  protected readonly emptyInventory = computed(
    () => this.store.page()?.total === 0 && this.store.predicates().length === 0,
  );
  protected readonly failureText = computed(() =>
    syncFailureText(this.sync()?.failure ?? null),
  );
  protected readonly telemetryText = computed(() =>
    telemetryFailureText(this.sync()?.telemetryFailure ?? null),
  );
  protected readonly label = chipLabel;
  protected readonly load = (offset: number, limit: number, sort: DeviceSort) => {
    this.store.setSort(sort);
    return this.store.rows(offset, limit);
  };

  constructor() {
    effect(() => {
      this.store.revision();
      untracked(() => void this.store.loadOrgUnits());
    });
  }

  ngOnInit(): void {
    void this.store.init();
  }

  protected count(value: number): string {
    return value.toLocaleString('en-US');
  }

  protected refresh(): void {
    void this.store.refreshAll();
  }

  protected reconnect(): void {
    void this.store.reconnect();
  }

  protected apply(predicate: DevicePredicate): void {
    const index = this.editingIndex();
    const predicates = [...this.store.predicates()];
    if (index === null) predicates.push(predicate);
    else predicates[index] = predicate;
    this.editingIndex.set(null);
    this.store.setPredicates(predicates);
  }

  protected remove(index: number): void {
    this.store.setPredicates(
      this.store.predicates().filter((_, position) => position !== index),
    );
  }

  protected clear(): void {
    this.store.setPredicates([]);
  }

  protected toggleColumn(column: OptionalDeviceColumn): void {
    this.store.optionalColumns.update((columns) => ({
      ...columns,
      [column]: !columns[column],
    }));
  }

  protected open(event: { row: DeviceRow; index: number }): void {
    this.store.position.set(event.index);
    void this.router.navigate(['/devices', event.row.deviceId]);
  }
}
```

Create `frontend/src/app/devices/devices.html`:

```html
<div class="devices">
  <header class="page-header">
    <h1>Devices</h1>
    <p class="subtitle">ChromeOS inventory</p>
  </header>

  @if (store.offline()) {
  <section class="banner" aria-labelledby="devices-offline-title">
    <h2 id="devices-offline-title">Cannot reach Campus Commander</h2>
    <p>Cached inventory remains visible.</p>
    <button mat-stroked-button type="button" (click)="reconnect()">Reconnect</button>
  </section>
  } @else if (published() && sync()?.stale) {
  <section class="banner" aria-labelledby="devices-stale-title">
    <h2 id="devices-stale-title">Inventory observation is stale</h2>
    <p>
      {{ failureText() || 'The inventory is more than 24 hours old.' }} Current data stays
      visible during refresh.
    </p>
    <button mat-stroked-button type="button" [disabled]="store.refreshing()" (click)="refresh()">
      Refresh inventory
    </button>
  </section>
  } @if (published() && telemetryText(); as text) {
  <section class="banner info" aria-labelledby="devices-battery-title">
    <h2 id="devices-battery-title">Battery data is unavailable</h2>
    <p>{{ text }}</p>
  </section>
  } @if (store.error()) {
  <p class="error" role="alert">{{ store.error() }}</p>
  }

  @if (!store.syncLoaded()) {
  @if (!store.offline()) {
  <p role="status">Loading device inventory…</p>
  } } @else if (!sync()) {
  <section class="card" aria-labelledby="devices-connect-title">
    <h2 id="devices-connect-title">Connect Google Workspace</h2>
    <p>Devices come from the connected Google Workspace customer.</p>
    <a mat-flat-button routerLink="/google-connection">Open Google connection</a>
  </section>
  } @else if (!published()) {
  <section class="card" aria-labelledby="devices-first-title" aria-live="polite">
    @if (store.refreshing()) {
    <h2 id="devices-first-title">Reading devices from Google Workspace</h2>
    <p>The inventory appears here when the refresh finishes.</p>
    } @else {
    <h2 id="devices-first-title">No device inventory yet</h2>
    <p>
      {{ sync()?.status === 'failed' ? failureText() : 'Refresh inventory to read ChromeOS devices from Google Workspace.' }}
    </p>
    <button mat-flat-button type="button" (click)="refresh()">Refresh inventory</button>
    }
  </section>
  } @else {
  <div class="filter-row">
    <div class="filters">
      @for (predicate of store.predicates(); track $index) {
      <span class="chip">
        <button type="button" class="chip-body" (click)="editingIndex.set($index)">
          {{ label(predicate) }}
        </button>
        <button
          type="button"
          class="chip-remove"
          [attr.aria-label]="'Remove filter ' + label(predicate)"
          (click)="remove($index)"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </span>
      } @if (store.predicates().length < 20 || editing()) {
      <app-device-filter
        [orgUnits]="store.orgUnits()"
        [editing]="editing()"
        (applied)="apply($event)"
        (closed)="editingIndex.set(null)"
      />
      }
      <button mat-button type="button" [disabled]="!store.predicates().length" (click)="clear()">
        Clear filters
      </button>
    </div>
    <div class="actions">
      <button mat-button type="button" [matMenuTriggerFor]="columnsMenu">Columns</button>
      <mat-menu #columnsMenu="matMenu">
        <button
          mat-menu-item
          type="button"
          role="menuitemcheckbox"
          [attr.aria-checked]="store.optionalColumns().annotatedLocation"
          (click)="toggleColumn('annotatedLocation')"
        >
          {{ store.optionalColumns().annotatedLocation ? 'Hide' : 'Show' }} Annotated location
        </button>
        <button
          mat-menu-item
          type="button"
          role="menuitemcheckbox"
          [attr.aria-checked]="store.optionalColumns().notes"
          (click)="toggleColumn('notes')"
        >
          {{ store.optionalColumns().notes ? 'Hide' : 'Show' }} Notes
        </button>
      </mat-menu>
      <button
        mat-button
        type="button"
        [matMenuTriggerFor]="refreshMenu"
        [disabled]="store.refreshing()"
      >
        {{ store.refreshing() ? 'Refreshing…' : 'Refresh' }}
      </button>
      <mat-menu #refreshMenu="matMenu">
        <button mat-menu-item type="button" (click)="refresh()">Refresh all</button>
      </mat-menu>
    </div>
  </div>
  @if (store.refreshing()) {
  <p class="visually-hidden" role="status">Refreshing device inventory.</p>
  }

  <div class="grid-region">
    @if (noMatches()) {
    <div class="grid-message" role="status">
      <h2>No devices match these filters</h2>
      <p>Check the serial or asset tag, or clear the current filters.</p>
      <button mat-flat-button type="button" (click)="clear()">Clear filters</button>
    </div>
    } @else if (emptyInventory()) {
    <div class="grid-message" role="status">
      <h2>No devices in this inventory</h2>
      <p>Google Workspace returned no ChromeOS devices for this customer.</p>
    </div>
    }
    <app-device-grid
      [class.hidden]="noMatches() || emptyInventory()"
      [load]="load"
      [revision]="store.revision()"
      [optionalColumns]="store.optionalColumns()"
      [focusIndex]="store.position()"
      (details)="open($event)"
      (rangeChange)="range.set($event)"
    />
  </div>

  <footer class="grid-footer" aria-live="polite">
    @if (store.page(); as page) {
    <p>{{ count(page.matching) }} matching devices · {{ count(page.total) }} in district</p>
    <p class="freshness">
      @if (store.offline()) { Cached inventory: {{ page.observedAt | date: 'MMM d, h:mm a' }} ·
      Connection unavailable } @else if (sync()?.stale) { Stale inventory · Last complete
      observation {{ page.observedAt | date: 'MMM d, h:mm a' }} · Refresh required } @else {
      Inventory observed {{ page.observedAt | date: 'MMM d, h:mm a' }} }
    </p>
    @if (range(); as visible) {
    <p class="rows">
      Rows {{ count(visible.first + 1) }}–{{ count(visible.last + 1) }} of {{ count(page.matching) }}
    </p>
    } } @else {
    <p>Loading devices…</p>
    }
  </footer>
  }
</div>
```

Create `frontend/src/app/devices/devices.css`:

```css
:host {
  display: block;
  min-width: 0;
}
.devices {
  display: flex;
  flex-direction: column;
  gap: var(--cc-space-md);
}
.page-header h1 {
  margin-block-end: 0;
}
.subtitle {
  margin-block-start: var(--cc-space-xs);
  color: var(--cc-text-secondary);
}
.banner {
  padding: var(--cc-card-padding);
  border-radius: var(--cc-radius-control);
  background: var(--cc-surface-hover);
}
.banner h2 {
  margin-block-start: 0;
  font-size: 16px;
}
.banner.info {
  border-inline-start: 4px solid var(--cc-status-info);
}
.error {
  color: var(--cc-status-error-text);
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cc-space-sm);
}
.filters,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cc-space-sm);
}
.chip {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-chip);
  background: var(--cc-surface-card);
}
.chip-body,
.chip-remove {
  min-height: 32px;
  border: 0;
  background: transparent;
  color: var(--cc-text-primary);
  cursor: pointer;
}
.chip-body {
  padding-inline: var(--cc-space-md) var(--cc-space-xs);
}
.chip-remove {
  display: inline-flex;
  align-items: center;
  padding-inline: var(--cc-space-xs) var(--cc-space-sm);
}
.chip-remove .material-symbols-outlined {
  font-size: 16px;
}
.grid-region {
  position: relative;
  height: max(420px, calc(100vh - 360px));
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius-control);
}
.grid-region app-device-grid.hidden {
  visibility: hidden;
}
.grid-message {
  position: absolute;
  z-index: 1;
  inset-block-start: 56px;
  inset-inline: var(--cc-space-lg);
}
.grid-message h2 {
  font-size: 16px;
}
.grid-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--cc-space-sm);
  color: var(--cc-text-secondary);
}
.grid-footer p {
  margin: 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: PASS for all six page tests.

- [ ] **Step 5: Add the route and the navigation link**

In `frontend/src/app/app.routes.ts`, import `devicesReadable` from `./devices/devices.store`. Add this child route as the first entry after the `''` redirect:

```ts
      {
        path: 'devices',
        title: 'Devices · Campus Commander',
        canActivate: [
          () =>
            devicesReadable(inject(AuthStore)) ||
            inject(Router).parseUrl('/account'),
        ],
        loadComponent: () =>
          import('./devices/devices').then((m) => m.DevicesPage),
      },
```

In `frontend/src/app/shell/shell.ts`, add `readonly devices = inject(DevicesStore);` beside the other store fields, and import `DevicesStore` from `../devices/devices.store`.

In `frontend/src/app/shell/shell.html`, replace `} @if (connection.readable()) {` with:

```html
    } @if (devices.readable()) {
    <a
      routerLink="/devices"
      routerLinkActive="active"
      ariaCurrentWhenActive="page"
      aria-label="Devices"
    >
      <mat-icon fontSet="material-symbols-outlined">laptop_chromebook</mat-icon
      ><span class="nav-label">Devices</span>
    </a>
    } @if (connection.readable()) {
```

- [ ] **Step 6: Build, lint, and test**

Run: `npm exec -- nx run-many -t build test lint -p frontend --skip-nx-cache`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app
git commit -m "feat: add the Devices page with filters, refresh, and inventory states"
```

---

### Task 7: Device details page

**Files:**
- Create: `frontend/src/app/devices/device-detail.ts`
- Create: `frontend/src/app/devices/device-detail.html`
- Create: `frontend/src/app/devices/device-detail.css`
- Create: `frontend/src/app/devices/device-detail.spec.ts`
- Modify: `frontend/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `DevicesStore.device`, `neighbor`, `position`, `page`, and `offline` (Task 3). `batteryText` and `relativeTime` (Task 2).
- Produces: route `/devices/:deviceId` showing `DeviceDetailPage` (`app-device-detail`) with a `deviceId` input from route binding.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/devices/device-detail.spec.ts`:

```ts
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { DeviceDetail } from '@campus/application-contracts';
import { DeviceDetailPage } from './device-detail';
import { DevicesStore } from './devices.store';

const device = (extra: Partial<DeviceDetail> = {}): DeviceDetail => ({
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-0001',
  model: 'Lenovo 100e Gen 4',
  assetTag: 'HS-0401',
  orgUnitPath: '/School A',
  lastContact: '2026-10-05T11:58:00.000Z',
  annotatedLocation: 'Science wing',
  notes: null,
  battery: { status: 'reported', health: 'replace-soon', capacityPercent: 78, reportedAt: '2026-10-05T13:50:00.000Z' },
  observedAt: '2026-10-05T14:00:00.000Z',
  batteryReports: [
    { reportedAt: '2026-10-05T13:50:00.000Z', health: 'replace-soon', capacityPercent: 78 },
    { reportedAt: '2026-10-04T13:50:00.000Z', health: 'replace-soon', capacityPercent: null },
  ],
  ...extra,
});

async function setup(options: {
  detail: DeviceDetail | null;
  position?: number | null;
  matching?: number;
  offline?: boolean;
}) {
  const store = {
    device: vi.fn().mockResolvedValue(options.detail),
    neighbor: vi.fn().mockResolvedValue({ ...device(), deviceId: 'synthetic-device-2', serialNumber: 'C0A1-0002' }),
    position: signal<number | null>(options.position ?? null),
    page: signal(options.matching === undefined ? null : { matching: options.matching, total: 450, observedAt: null }),
    offline: signal(options.offline ?? false),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DevicesStore, useValue: store }],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(DeviceDetailPage);
  fixture.componentRef.setInput('deviceId', 'synthetic-device-1');
  const element: HTMLElement = fixture.nativeElement;
  // The app is zoneless, so wait for the untracked device read to render.
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Loading device details');
  });
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  return { store, element, navigate, button };
}

it('shows the Google battery class, capacity, and recent reports', async () => {
  const { element } = await setup({ detail: device() });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe('C0A1-0001');
  expect(element.textContent).toContain('Battery health · Replace soon');
  expect(element.textContent).toContain('78% of design capacity');
  expect(element.textContent).toContain('Classified by Google');
  expect(element.textContent).toContain('Science wing');
  expect([...element.querySelectorAll('.reports li')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toHaveLength(2);
  expect(element.textContent).toContain('No capacity');
});

it('names the power-status policy when Google sent no battery report', async () => {
  const { element } = await setup({ detail: device({ battery: { status: 'no-report' }, batteryReports: [] }) });
  expect(element.textContent).toContain('No battery report');
  expect(element.textContent).toContain('ReportDevicePowerStatus');
});

it('explains unavailable battery data', async () => {
  const { element } = await setup({ detail: device({ battery: { status: 'unavailable' }, batteryReports: [] }) });
  expect(element.textContent).toContain('Battery data unavailable');
});

it('opens the next device in the filtered order', async () => {
  const { store, navigate, button } = await setup({ detail: device(), position: 0, matching: 2 });
  button('Next device')!.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(store.neighbor).toHaveBeenCalledWith(1);
  expect(store.position()).toBe(1);
  expect(navigate).toHaveBeenCalledWith(['/devices', 'synthetic-device-2']);
});

it('disables Next device on the last matching row', async () => {
  const { button } = await setup({ detail: device(), position: 1, matching: 2 });
  expect(button('Next device')!.disabled).toBe(true);
});

it('disables Next device after a deep link', async () => {
  const { button, element } = await setup({ detail: device(), position: null });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe('C0A1-0001');
  expect(button('Next device')!.disabled).toBe(true);
});

it('shows not found for a missing device', async () => {
  const { element } = await setup({ detail: null });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe('Device not found');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec -- nx run frontend:test --skip-nx-cache`
Expected: FAIL. Vite cannot resolve `./device-detail`.

- [ ] **Step 3: Write the component**

Create `frontend/src/app/devices/device-detail.ts`:

```ts
import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import type {
  DeviceBattery,
  DeviceDetail,
} from '@campus/application-contracts';
import { DevicesStore } from './devices.store';
import { batteryText, relativeTime } from './device-fields';

@Component({
  selector: 'app-device-detail',
  imports: [DatePipe, RouterLink, MatButtonModule],
  templateUrl: './device-detail.html',
  styleUrl: './device-detail.css',
})
export class DeviceDetailPage {
  readonly deviceId = input.required<string>();
  protected readonly store = inject(DevicesStore);
  private readonly router = inject(Router);
  protected readonly device = signal<DeviceDetail | null>(null);
  protected readonly status = signal<'loading' | 'ready' | 'missing' | 'offline'>(
    'loading',
  );
  protected readonly hasNext = computed(() => {
    const position = this.store.position();
    const page = this.store.page();
    return position !== null && page !== null && position + 1 < page.matching;
  });
  protected readonly relative = relativeTime;

  constructor() {
    effect(() => {
      const id = this.deviceId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    this.status.set('loading');
    const device = await this.store.device(id);
    if (this.deviceId() !== id) return;
    this.device.set(device);
    this.status.set(device ? 'ready' : this.store.offline() ? 'offline' : 'missing');
  }

  protected retry(): void {
    void this.load(this.deviceId());
  }

  protected async next(): Promise<void> {
    const position = this.store.position();
    if (position === null) return;
    const row = await this.store.neighbor(position + 1);
    if (!row) return;
    this.store.position.set(position + 1);
    await this.router.navigate(['/devices', row.deviceId]);
  }

  protected identity(device: DeviceDetail): string {
    return [device.model, device.assetTag].filter(Boolean).join(' · ') || 'ChromeOS device';
  }

  protected healthClass(battery: DeviceBattery): string {
    if (battery.status !== 'reported') return '';
    return battery.health === 'normal' ? 'normal' : battery.health === 'replace-soon' ? 'soon' : 'now';
  }

  protected healthLabel(battery: DeviceBattery): string {
    return batteryText(battery);
  }

  protected capacityText(battery: DeviceBattery): string {
    return battery.status === 'reported' && battery.capacityPercent !== null
      ? `${battery.capacityPercent}% of design capacity`
      : 'Capacity not reported';
  }

  protected reportedAt(battery: DeviceBattery): string | null {
    return battery.status === 'reported' ? battery.reportedAt : null;
  }
}
```

Create `frontend/src/app/devices/device-detail.html`:

```html
<div class="device-detail">
  @switch (status()) { @case ('loading') {
  <p role="status">Loading device details…</p>
  } @case ('offline') {
  <section class="card" aria-labelledby="device-offline-title">
    <h1 id="device-offline-title">Cannot reach Campus Commander</h1>
    <p>Device details need a connection.</p>
    <div class="actions">
      <a mat-stroked-button routerLink="/devices">Back to devices</a>
      <button mat-flat-button type="button" (click)="retry()">Retry</button>
    </div>
  </section>
  } @case ('missing') {
  <section class="card" aria-labelledby="device-missing-title">
    <h1 id="device-missing-title">Device not found</h1>
    <p>The current inventory has no device with this ID.</p>
    <a mat-stroked-button routerLink="/devices">Back to devices</a>
  </section>
  } @case ('ready') { @if (device(); as current) {
  <header class="page-header">
    <h1>{{ current.serialNumber || current.deviceId }}</h1>
    <p class="subtitle">Device details · {{ current.orgUnitPath }}</p>
  </header>
  <div class="actions">
    <a mat-stroked-button routerLink="/devices">Back to devices</a>
    <button mat-stroked-button type="button" [disabled]="!hasNext()" (click)="next()">
      Next device
    </button>
  </div>
  <div class="detail-layout">
    <section class="card" aria-labelledby="device-identity-title">
      <h2 id="device-identity-title">{{ identity(current) }}</h2>
      <p>{{ current.orgUnitPath }}</p>
      <p class="secondary">
        Inventory observed {{ current.observedAt | date: 'MMM d, h:mm a' }}
      </p>
      <dl class="annotations">
        <div class="annotation">
          <dt>Annotated location</dt>
          <dd>{{ current.annotatedLocation || 'Not set' }}</dd>
        </div>
        <div class="annotation">
          <dt>Notes</dt>
          <dd>{{ current.notes || 'Not set' }}</dd>
        </div>
      </dl>
      <p>Last device contact: {{ relative(current.lastContact) }}</p>
    </section>
    <section class="card battery" aria-labelledby="battery-title">
      @switch (current.battery.status) { @case ('reported') {
      <h2 id="battery-title" class="health" [class]="healthClass(current.battery)">
        Battery health · {{ healthLabel(current.battery) }}
      </h2>
      <p class="capacity">{{ capacityText(current.battery) }}</p>
      <p>
        Health compares full-charge capacity with design capacity. It does not show
        current charge.
      </p>
      <p class="secondary">
        Classified by Google: Normal above 80%, Replace soon from 75% to 80%, Replace now
        below 75% of design capacity.
      </p>
      <p class="secondary">
        Latest report: {{ reportedAt(current.battery) | date: 'MMM d, h:mm a' }}
      </p>
      <h3>Recent reports</h3>
      <ul class="reports">
        @for (report of current.batteryReports; track report.reportedAt) {
        <li>
          <span>{{ report.reportedAt | date: 'MMM d' }}</span>
          <span>{{ report.capacityPercent === null ? 'No capacity' : report.capacityPercent + '%' }}</span>
        </li>
        }
      </ul>
      } @case ('no-report') {
      <h2 id="battery-title">No battery report</h2>
      <p>Google has not reported battery data for this device.</p>
      <p class="secondary">
        Common causes: the ReportDevicePowerStatus device policy is off, or the device has
        no battery.
      </p>
      } @default {
      <h2 id="battery-title">Battery data unavailable</h2>
      <p>The last inventory refresh could not read battery telemetry from Google.</p>
      } }
    </section>
  </div>
  } } }
</div>
```

Create `frontend/src/app/devices/device-detail.css`:

```css
:host {
  display: block;
  min-width: 0;
}
.page-header h1 {
  margin-block-end: 0;
}
.subtitle,
.secondary {
  color: var(--cc-text-secondary);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cc-space-sm);
  margin-block: var(--cc-space-lg);
}
.detail-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--cc-space-lg);
  align-items: start;
}
@media (max-width: 900px) {
  .detail-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.annotations {
  display: grid;
  gap: var(--cc-space-md);
  margin: 0;
}
.annotation {
  padding: var(--cc-space-sm) var(--cc-space-md);
  border: 1px solid var(--cc-border-control);
  border-radius: var(--cc-radius-control);
}
.annotation dt {
  font-size: 12px;
  color: var(--cc-text-secondary);
}
.annotation dd {
  margin: 0;
}
.health {
  font-size: 16px;
}
.health.normal {
  color: var(--cc-status-success-text);
}
.health.soon {
  color: var(--cc-status-warning-text);
}
.health.now {
  color: var(--cc-status-error-text);
}
.capacity {
  font-size: 24px;
  font-weight: 500;
}
.reports {
  margin: 0;
  padding: 0;
  list-style: none;
}
.reports li {
  display: grid;
  grid-template-columns: 64px auto;
  gap: var(--cc-space-md);
}
```

- [ ] **Step 4: Add the route**

In `frontend/src/app/app.routes.ts`, add directly after the `devices` route:

```ts
      {
        path: 'devices/:deviceId',
        title: 'Device details · Campus Commander',
        canActivate: [
          () =>
            devicesReadable(inject(AuthStore)) ||
            inject(Router).parseUrl('/account'),
        ],
        loadComponent: () =>
          import('./devices/device-detail').then((m) => m.DeviceDetailPage),
      },
```

- [ ] **Step 5: Build, lint, and test**

Run: `npm exec -- nx run-many -t build test lint -p frontend --skip-nx-cache`
Expected: PASS for all seven details tests and the existing specs.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app
git commit -m "feat: add device details with Google battery health"
```

---

### Task 8: Browser check and review guide

**Files:**
- Create: `api-e2e/devices-browser.mjs`
- Modify: `api-e2e/auth.test.mjs` (run the browser check after `qualifyDevicesApi`)
- Modify: `docs/testing/client-review.md`
- Modify: `docs/workflows/device-browsing.md` (implementation defaults and design deviations)
- Modify: `docs/document-index.csv` (status of the two documents)

**Interfaces:**
- Consumes: every earlier task through the real application. `qualifyDevicesApi` leaves the last sync failed and stale, with the fault file removed.

- [ ] **Step 1: Write the failing browser check**

Create `api-e2e/devices-browser.mjs`:

```js
import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import { expect } from '@playwright/test';

export async function qualifyDevicesBrowser({
  browser,
  auditAccessibility,
  publicOrigin,
  evidenceDirectory,
  setSubject,
}) {
  const context = await evidenceSecurity.newContext(browser, {
    ignoreHTTPSErrors: true,
  });
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await qualificationSignIn(page, publicOrigin, evidenceDirectory, 'devices-browser');
    await page.getByRole('link', { name: 'Devices' }).click();
    await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inventory observation is stale' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh inventory' }).click();
    await expect(page.getByText('450 matching devices · 450 in district')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Inventory observation is stale' })).toHaveCount(0);
    await auditAccessibility(page, 'devices');

    await page.locator('.add-filter').click();
    await page.getByRole('combobox', { name: 'Filter field' }).fill('asset');
    await page.getByRole('option', { name: 'Asset tag', exact: true }).click();
    await page.getByLabel('Operator').selectOption('startsWith');
    await page.getByLabel('Value').fill('HS-04');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: 'Asset tag starts with: HS-04' })).toBeVisible();
    await expect(page.getByText('96 matching devices · 450 in district')).toBeVisible();

    await page.getByRole('button', { name: 'Open details for C0A1-0001' }).click();
    await expect(page.getByRole('heading', { name: 'C0A1-0001', level: 1 })).toBeVisible();
    await expect(page.getByText('78% of design capacity')).toBeVisible();
    await expect(page.getByText('Classified by Google')).toBeVisible();
    await auditAccessibility(page, 'device-details');
    await page.getByRole('button', { name: 'Next device' }).click();
    await expect(page.getByRole('heading', { name: 'C0A1-0002', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Back to devices' }).click();
    await expect(page.getByRole('button', { name: 'Asset tag starts with: HS-04' })).toBeVisible();
    await expect(page.getByText('96 matching devices · 450 in district')).toBeVisible();

    await page.goto(`${publicOrigin}/devices/synthetic-device-9`);
    await expect(page.getByRole('heading', { name: 'No battery report' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next device' })).toBeDisabled();
    return [
      'devices page refreshes a stale inventory and shows counts: pass',
      'typed asset tag filter narrows the grid and keeps its chip after details: pass',
      'device details show Google battery health and follow the filtered order: pass',
      'deep-linked device without battery reports names the power-status policy: pass',
    ];
  } finally {
    await context.close();
  }
}
```

In `api-e2e/auth.test.mjs`, import `qualifyDevicesBrowser` from `./devices-browser.mjs`. Add this block directly after the `qualifyDevicesApi` block:

```js
      if (applicationPhase === 3)
        await qualifyDevicesBrowser({
          browser,
          auditAccessibility,
          publicOrigin,
          evidenceDirectory,
          setSubject: (value) => {
            subject = value;
          },
        });
```

- [ ] **Step 2: Run the check and confirm it fails**

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache`
Expected: FAIL only when an earlier task is incomplete. With Tasks 1 through 7 committed, it passes on the first run. In that case, record a ruling that the check verified finished work. Then confirm that it can fail: temporarily change the expected serial `C0A1-0002` to `C0A1-0003` and watch it fail. Restore the value.

- [ ] **Step 3: Update the review guide and the workflow record**

In `docs/testing/client-review.md`, add this bullet to "Review the features" after the Google connection bullet:

```markdown
- **Devices:** Select **Refresh inventory**, add a filter, open a device, and use **Next device** and **Back to devices**.
  The simulated customer has 450 devices with all battery classes.
```

In `docs/workflows/device-browsing.md`, append to "Implementation defaults — 2026-10-05":

```markdown
- A Columns menu in the filter row shows or hides Annotated location and Notes. Figma has no column control.
- Without a Google connection, Devices directs the administrator to the Google connection page.
- The OrgUnit filter lists the OrgUnits of the published inventory and their ancestors.
```

In the same file, append to the "Deviations from the frames" paragraph:

```markdown
The battery coverage page (`105:146`) is excluded. Device details list the recent reports that Google returns.
```

In `docs/document-index.csv`, set the inspection field of the `docs/testing/client-review.md` and `docs/workflows/device-browsing.md` rows to `"Devices UI recorded, 2026-10-05"`. Preserve the CRLF line endings.

- [ ] **Step 4: Run every check**

Run: `npm exec -- nx run-many -t lint test build -p application-contracts api frontend --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache`
Expected: PASS, with the browser check and both accessibility audits passing.

- [ ] **Step 5: Commit**

```bash
git add api-e2e docs/testing/client-review.md docs/workflows/device-browsing.md docs/document-index.csv
git commit -m "test: browse, filter, and open devices in the browser check"
```

## After this plan

- Demonstrate the Completion list in the workflow record with `npm exec -- nx run api-e2e:client-review`.
- The live Easton check waits for the owner to add both device scopes in the Google Admin Console.
