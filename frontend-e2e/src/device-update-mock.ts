import { type Page } from '@playwright/test';
import type { DeviceUpdateChange } from '@campus/application-contracts';
import {
  U6Simulator,
  orgUnitTree,
  type SimulatedDevice,
} from './device-update-u6-simulator';

/**
 * The simulated API of the Update device completion checks. The preview, the target rows, and
 * every count come from the production U6 calculation inside `U6Simulator`; this module only
 * carries them over HTTP. Google and PostgreSQL stay simulated, so no live API answers.
 *
 * Two Chromium specs share this source: F2 checks the three text fields, and F3 checks the
 * Organization unit field and its picker.
 */

const customerId = 'C0123456';
const previewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jobDisplayId = 'UPD-007';

export const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
];

export interface MockOptions {
  /** The answer of `GET /api/devices/updates/org-units`. Defaults to the granted tree. */
  orgUnits?: unknown;
  /** Answers each read, so a test can change the grant between two openings. */
  orgUnitsAnswer?: () => unknown;
}

export interface Mock {
  sim: U6Simulator;
  /** The last preview request body, for an assertion. */
  posted: { changes?: DeviceUpdateChange[] };
  /** Apply the settled write and publish the U6 `entity-batch` event. */
  settle: () => Promise<void>;
}

/**
 * A stateful U6 answer source. The preview and target rows come from the production U6
 * calculation inside `U6Simulator`; this function only carries them over HTTP.
 */
export async function mockApi(
  page: Page,
  devices: SimulatedDevice[],
  options: MockOptions = {},
): Promise<Mock> {
  const sim = new U6Simulator(devices);
  const posted: { changes?: DeviceUpdateChange[] } = {};
  await fakeDeviceStream(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    const method = request.method();

    if (method === 'POST' && routePath === '/api/devices/updates/previews') {
      const body = request.postDataJSON() as { changes: DeviceUpdateChange[] };
      posted.changes = body.changes;
      return route.fulfill({ status: 201, json: sim.prepare(body.changes) });
    }
    // F3 reads the tree of the picker, not the unit list of the grid filter.
    if (method === 'GET' && routePath === '/api/devices/updates/org-units')
      return route.fulfill({
        json: options.orgUnitsAnswer
          ? options.orgUnitsAnswer()
          : (options.orgUnits ?? orgUnitTree),
      });
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}`
    )
      return route.fulfill({ json: sim.current() });
    if (
      method === 'GET' &&
      routePath === `/api/devices/updates/previews/${previewId}/targets`
    )
      return route.fulfill({
        json: { targets: sim.targets(), nextCursor: null },
      });
    if (method === 'POST' && routePath.endsWith('/confirm')) {
      const body = request.postDataJSON() as {
        manifestDigest: string;
        acknowledged: boolean;
      };
      // The client sends the digest of the frozen preview. A stale digest is a 409.
      if (
        body.acknowledged !== true ||
        body.manifestDigest !== sim.current().manifestDigest
      )
        return route.fulfill({
          status: 409,
          json: { reason: 'preview-changed' },
        });
      return route.fulfill({ status: 201, json: sim.confirm() });
    }
    if (routePath === `/api/jobs/${jobDisplayId}`)
      return route.fulfill({ json: sim.jobDetail() });
    if (method === 'POST' && routePath === '/api/devices/query') {
      const body = request.postDataJSON() as {
        predicates?: Parameters<U6Simulator['page']>[0];
      };
      return route.fulfill({ json: { page: sim.page(body.predicates ?? []) } });
    }
    if (method === 'POST' && routePath === '/api/devices/by-ids') {
      const body = request.postDataJSON() as { deviceIds: string[] };
      return route.fulfill({ json: { rows: sim.byIds(body.deviceIds) } });
    }
    if (routePath === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (routePath === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'District operator',
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: { theme: 'light', navigationCollapsed: false },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (routePath === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: devices.length,
            excluded: 0,
            selectedCount: devices.length,
            expiredAt: null,
          },
        },
      });
    if (routePath === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (routePath === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt: '2026-10-21T12:00:00.000Z',
            deviceCount: devices.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (routePath === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (routePath === '/api/devices/org-units')
      return route.fulfill({
        json: {
          // The grid filter lists one row per unit of the inventory.
          orgUnits: [
            { path: '/', devices: 6 },
            { path: '/Chrome Devices', devices: 6 },
            { path: '/Chrome Devices/Cart Devices', devices: 5 },
            { path: '/Chrome Devices/Lowell Academy/One to One', devices: 1 },
          ],
        },
      });
    if (routePath === '/api/devices/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
      });
    if (routePath === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: '2026-10-21T12:00:00.000Z',
        },
      });
    if (routePath === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (routePath === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (routePath === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (routePath === '/api/auth/preferences')
      return route.fulfill({ json: request.postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
  return {
    sim,
    posted,
    settle: async () => {
      const changed = sim.settle();
      await page.waitForFunction(
        () =>
          (window as unknown as { __deviceSources?: unknown[] }).__deviceSources
            ?.length,
      );
      await page.evaluate(
        (deviceIds) =>
          (
            window as unknown as {
              __emitEntityBatch: (ids: string[]) => void;
            }
          ).__emitEntityBatch(deviceIds),
        changed,
      );
    },
  };
}

/**
 * Playwright cannot hold an SSE response open with `route.fulfill`. The fake opens once and
 * relays the `entity-batch` event that a settled update job publishes.
 */
export async function fakeDeviceStream(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as {
      __deviceSources: {
        readyState: number;
        emit: (type: string, event: Event) => void;
      }[];
      __emitEntityBatch: (deviceIds: string[]) => void;
    };
    state.__deviceSources = [];
    class FakeEventSource {
      readyState = 0;
      private readonly listeners = new Map<
        string,
        ((event: Event) => void)[]
      >();
      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.emit('open', new Event('open'));
        }, 0);
        state.__deviceSources.push(this);
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      close() {
        this.readyState = 2;
      }
      emit(type: string, event: Event) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
    state.__emitEntityBatch = (deviceIds: string[]) => {
      for (const source of state.__deviceSources) {
        if (source.readyState === 2) continue;
        source.emit(
          'entity-batch',
          new MessageEvent('entity-batch', {
            data: JSON.stringify({
              type: 'entity-batch',
              entityType: 'device',
              deviceIds,
              removedIds: [],
            }),
          }),
        );
      }
    };
  });
}
