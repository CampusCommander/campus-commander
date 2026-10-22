import { Injectable, computed, inject, signal } from '@angular/core';
import {
  deviceOrgUnitTreeSchema,
  type DeviceOrgUnitTree,
  type DeviceOrgUnitTreeEntry,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DEVICE_ORG_UNIT_SCOPE } from './device-update-messages';

/** One row of the shared organization unit tree (TREE-01). */
export interface OrgUnitTreeRow {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
}

/**
 * The organization unit tree of the connected customer (design section 6). The sheet reads
 * it once when it opens, so a missing read scope disables the Organization unit field before
 * the operator chooses a mode. The route keeps no cache, so Recheck reads it again.
 */
@Injectable({ providedIn: 'root' })
export class DeviceOrgUnitTreeStore {
  private readonly auth = inject(AuthStore);
  readonly tree = signal<DeviceOrgUnitTree | null>(null);
  readonly loading = signal(false);
  /** A recovery message for the last failed read. */
  readonly message = signal('');
  readonly state = computed(() => this.tree()?.state ?? null);
  /** The scope that the field note names. */
  readonly scope = computed(() => this.tree()?.scope ?? DEVICE_ORG_UNIT_SCOPE);
  /** The tree as the shared picker reads it, or null while the read is not granted. */
  readonly units = computed<OrgUnitTreeRow[] | null>(() => {
    const units = this.tree()?.orgUnits;
    return units ? units.map(toRow) : null;
  });
  private inFlight: Promise<DeviceOrgUnitTree | null> | null = null;

  /** Read the tree. Each call reads again; a second call while one runs shares its answer. */
  async load(): Promise<DeviceOrgUnitTree | null> {
    if (this.inFlight) return this.inFlight;
    this.loading.set(true);
    this.inFlight = this.read();
    const answer = await this.inFlight;
    this.inFlight = null;
    this.loading.set(false);
    return answer;
  }

  private async read(): Promise<DeviceOrgUnitTree | null> {
    try {
      const response = await this.auth.request(
        '/api/devices/updates/org-units',
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        this.tree.set(null);
        this.message.set(
          response.status === 403
            ? 'You do not have permission to read the organization units.'
            : response.status === 409
              ? 'Connect Google Workspace before you choose an organization unit.'
              : 'Google organization unit reads are unavailable.',
        );
        return null;
      }
      const tree = deviceOrgUnitTreeSchema.safeParse(body);
      if (!tree.success) {
        this.tree.set(null);
        this.message.set(
          'The organization unit answer was not readable. Check it again.',
        );
        return null;
      }
      this.message.set('');
      this.tree.set(tree.data);
      return tree.data;
    } catch {
      this.tree.set(null);
      this.message.set(
        'Cannot reach Campus Commander. Check organization units when the connection returns.',
      );
      return null;
    }
  }
}

function toRow(unit: DeviceOrgUnitTreeEntry): OrgUnitTreeRow {
  return {
    id: unit.orgUnitId,
    name: unit.name,
    path: unit.orgUnitPath,
    parentId: unit.parentOrgUnitId,
  };
}
