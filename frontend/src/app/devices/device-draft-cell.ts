import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';
import type {
  DeviceRow,
  DeviceUpdateField,
} from '@campus/application-contracts';
import type { DeviceGridDraftEntry } from './device-grid-draft.store';
import { deviceUpdateValueCounter } from './device-update-messages';

/** The parameters that the editable device columns pass to this renderer. */
export interface DeviceDraftCellParams
  extends ICellRendererParams<DeviceRow, string> {
  updateField: DeviceUpdateField;
  label: string;
  entryFor: (deviceId: string) => DeviceGridDraftEntry | null;
  reasonFor: (entry: DeviceGridDraftEntry) => string;
  editable: () => boolean;
  onRevert: (deviceId: string) => void;
  onConflict: (deviceId: string, anchor: HTMLElement) => void;
}

function readable(value: string | null | undefined): string {
  return value === null || value === undefined || value === ''
    ? 'No value'
    : value;
}

/**
 * One editable device cell (addendum section 5, DRAFT-02).
 *
 * The cell shows the pending draft value over the row value, marks the pending, invalid, or
 * conflict state, and offers the per-cell rollback icon. The editor itself is the AG Grid
 * text or large text editor; this renderer draws the resting cell only.
 */
@Component({
  selector: 'app-device-draft-cell',
  templateUrl: './device-draft-cell.html',
  styleUrl: './device-draft-cell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceDraftCell implements ICellRendererAngularComp {
  private readonly params = signal<DeviceDraftCellParams | null>(null);

  protected readonly data = computed(() => this.params()?.data ?? null);
  protected readonly label = computed(() => this.params()?.label ?? '');
  protected readonly text = computed(() => {
    const value = this.params()?.value;
    return value === null || value === undefined ? '' : String(value);
  });
  protected readonly entry = computed(() => {
    const params = this.params();
    if (!params?.data || params.node?.group) return null;
    return params.entryFor(params.data.deviceId);
  });
  protected readonly editable = computed(
    () => this.params()?.editable() ?? false,
  );
  protected readonly reason = computed(() => {
    const entry = this.entry();
    return entry ? (this.params()?.reasonFor(entry) ?? '') : '';
  });
  /** The tooltip of the error icon: the counter for a text field, else the reason. */
  protected readonly errorTitle = computed(() => {
    const entry = this.entry();
    if (!entry) return '';
    if (
      entry.field === 'annotatedLocation' ||
      entry.field === 'annotatedUser' ||
      entry.field === 'notes'
    )
      return deviceUpdateValueCounter(entry.field, entry.value);
    return this.reason();
  });
  protected readonly serialNumber = computed(
    () => this.data()?.serialNumber ?? 'this device',
  );
  protected readonly revertLabel = computed(
    () => `Revert ${this.label().toLowerCase()} of ${this.serialNumber()}`,
  );
  protected readonly conflictLabel = computed(
    () =>
      `Resolve conflict on ${this.label().toLowerCase()} of ${this.serialNumber()}`,
  );
  protected readonly stateText = computed(() => {
    const entry = this.entry();
    if (!entry) return '';
    if (entry.state === 'invalid')
      return `Invalid change to ${this.label().toLowerCase()}. ${this.reason()}`;
    if (entry.state === 'conflict')
      return `Conflict on ${this.label().toLowerCase()}. Current value: ${readable(entry.currentValue)}.`;
    return `Pending change to ${this.label().toLowerCase()}. Baseline: ${readable(entry.baseline)}.`;
  });

  agInit(params: DeviceDraftCellParams): void {
    this.params.set(params);
  }

  refresh(params: DeviceDraftCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected revert(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const params = this.params();
    if (params?.data) params.onRevert(params.data.deviceId);
  }

  protected openConflict(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const params = this.params();
    if (params?.data)
      params.onConflict(
        params.data.deviceId,
        event.currentTarget as HTMLElement,
      );
  }
}
