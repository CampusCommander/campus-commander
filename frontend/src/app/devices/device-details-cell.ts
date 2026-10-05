import { Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';

export interface DeviceDetailsCellParams
  extends ICellRendererParams<DeviceRow> {
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
      <span class="material-symbols-outlined" aria-hidden="true"
        >visibility</span
      >
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
    return data
      ? `Open details for ${data.serialNumber || data.deviceId}`
      : 'Open details';
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
