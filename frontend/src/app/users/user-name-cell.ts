import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams, IRowNode } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import { userName } from './user-fields';

export interface UserNameCellParams extends ICellRendererParams<UserRow> {
  /**
   * Records the row that the person opens, so Next user walks the grid's order and
   * Back to users returns to it. The link itself carries the navigation.
   */
  onOpen(row: UserRow, node: IRowNode<UserRow>): void;
}

/**
 * The Name cell of the users grid. The name links to the user details page, and it
 * keeps the read-only text of a row that is refreshing (A section 15.4).
 */
@Component({
  selector: 'app-user-name-cell',
  imports: [RouterLink],
  template: `
    @if (row(); as current) {
      <a
        class="user-name"
        [routerLink]="['/users', current.userId]"
        (click)="opened()"
        >{{ text() }}</a
      >
    }
  `,
  styles: `
    .user-name {
      color: var(--cc-text-link);
      overflow-wrap: anywhere;
    }
  `,
})
export class UserNameCell implements ICellRendererAngularComp {
  private readonly params = signal<UserNameCellParams | null>(null);
  protected readonly row = computed(() => this.params()?.data ?? null);
  protected readonly text = computed(() => {
    const data = this.params()?.data;
    return data ? userName(data) : '';
  });

  agInit(params: UserNameCellParams): void {
    this.params.set(params);
  }

  refresh(params: UserNameCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected opened(): void {
    const params = this.params();
    if (params?.data) params.onOpen(params.data, params.node);
  }
}
