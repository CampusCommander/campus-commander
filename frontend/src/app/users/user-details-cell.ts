import { Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams, IRowNode } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import { userName } from './user-fields';

export interface UserDetailsCellParams extends ICellRendererParams<UserRow> {
  onDetails(row: UserRow, node: IRowNode<UserRow>): void;
}

/**
 * GRID-03 details icon of the users grid. The icon opens the user details page.
 *
 * The eye is inline SVG: the icon font painted a stray ellipsis under the glyph in
 * the grid cell, and the control must match the approved screen exactly.
 */
@Component({
  selector: 'app-user-details-cell',
  template: `
    <button
      type="button"
      class="details-action"
      [attr.aria-label]="label()"
      [attr.title]="label()"
      (click)="activate()"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
      >
        <path
          d="M2.2 12s3.5-6.2 9.8-6.2S21.8 12 21.8 12s-3.5 6.2-9.8 6.2S2.2 12 2.2 12Z"
        />
        <circle cx="12" cy="12" r="3.1" />
      </svg>
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
    .details-action svg {
      width: 24px;
      height: 24px;
      display: block;
    }
  `,
})
export class UserDetailsCell implements ICellRendererAngularComp {
  private readonly params = signal<UserDetailsCellParams | null>(null);
  protected readonly label = computed(() => {
    const data = this.params()?.data;
    return data ? `Open details for ${userName(data)}` : 'Open details';
  });

  agInit(params: UserDetailsCellParams): void {
    this.params.set(params);
  }

  refresh(params: UserDetailsCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected activate(): void {
    const params = this.params();
    if (params?.data && !params.node.group)
      params.onDetails(params.data, params.node);
  }
}
