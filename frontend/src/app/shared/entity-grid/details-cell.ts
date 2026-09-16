import { Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';

export interface DetailsCellParams<TRow = unknown>
  extends ICellRendererParams<TRow, unknown> {
  getRowId(row: TRow): string;
  entityLabel(row: TRow): string;
  onDetails(stableId: string): void;
}

/**
 * GRID-03 details icon. Opens the detail page for the row's stable entity ID.
 * Detail navigation stays separate from selection and cell editing.
 */
@Component({
  selector: 'app-entity-grid-details-cell',
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
    .details-action .material-symbols-outlined {
      font-size: 20px;
    }
  `,
})
export class EntityGridDetailsCell implements ICellRendererAngularComp {
  private readonly params = signal<DetailsCellParams | null>(null);

  protected readonly label = computed(() => {
    const params = this.params();
    if (!params?.data) {
      return 'Open details';
    }
    return `Open details for ${params.entityLabel(params.data)}`;
  });

  agInit(params: DetailsCellParams): void {
    this.params.set(params);
  }

  refresh(params: DetailsCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected activate(): void {
    const params = this.params();
    if (params?.data) {
      params.onDetails(params.getRowId(params.data));
    }
  }
}
