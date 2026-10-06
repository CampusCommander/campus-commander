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
