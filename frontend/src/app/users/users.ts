import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import type {
  Action,
  UserPredicate,
  UserRow,
  UserSelectionKey,
} from '@campus/application-contracts';
import type { GridState } from 'ag-grid-community';
import { AuthStore } from '../auth.store';
import {
  BULK_ACTIONS_LABEL,
  BULK_SELECT_NOTE,
  BULK_SET_ATTRIBUTES_LABEL,
} from './user-attribute-bulk-messages';
import { UserAttributeBulkDialog } from './user-attribute-bulk-dialog';
import { USER_GRID_ID } from './user-selection';
import { CUSTOM_ATTRIBUTES_LABEL } from './user-attribute-messages';
import { UserAttributeCategories } from './user-attribute-categories';
import { UserFilter } from './user-filter';
import {
  chipLabel,
  needsGoogleConnection,
  syncFailureText,
} from './user-fields';
import { userFreshnessBanner } from './user-freshness';
import { UserGrid } from './user-grid';
import type { UserView } from './user-datasource';
import { predicateFieldKey } from './user-filter-model';
import {
  REFRESH_DOMAIN_SUPPORT,
  REFRESH_SELECTED_SUPPORT,
} from './user-refresh-messages';
import { UsersStore } from './users.store';

@Component({
  selector: 'app-users',
  imports: [
    MatButtonModule,
    MatMenuModule,
    MatTabsModule,
    RouterLink,
    UserAttributeBulkDialog,
    UserAttributeCategories,
    UserFilter,
    UserGrid,
  ],
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class UsersPage implements OnInit, OnDestroy {
  protected readonly store = inject(UsersStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly editingIndex = signal<number | null>(null);
  /** The selected tab: the Users grid, or the Custom attributes categories (U2). */
  protected readonly tab = signal<'users' | 'attributes'>('users');
  protected readonly CUSTOM_ATTRIBUTES_LABEL = CUSTOM_ATTRIBUTES_LABEL;
  private readonly chips = viewChildren<ElementRef<HTMLButtonElement>>('chip');
  protected readonly refreshMenuOpen = signal(false);
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.store.predicates()[index] ?? null);
  });
  protected readonly sync = computed(() => this.store.sync());
  protected readonly published = computed(() => !!this.sync()?.observedAt);
  protected readonly noMatches = computed(
    () =>
      (this.store.emptyFilter() ||
        (this.store.page()?.matching === 0 &&
          this.store.predicates().length > 0)) &&
      // Show All Selected keeps the grid, so its footer can return to all users.
      !this.store.view().selection,
  );
  protected readonly emptyDirectory = computed(
    () =>
      this.store.page()?.total === 0 &&
      this.store.predicates().length === 0 &&
      !this.store.emptyFilter(),
  );
  /** A chip clears. A column filter that matches no row clears too (R6). */
  protected readonly hasFilters = computed(
    () => this.store.predicates().length > 0 || this.store.emptyFilter(),
  );
  protected readonly failureText = computed(() =>
    syncFailureText(this.sync()?.failure ?? null),
  );
  /** The Google connection page carries the fix for a missing scope or credential. */
  protected readonly connectionNeeded = computed(() =>
    needsGoogleConnection(this.sync()?.failure ?? null),
  );
  /** The stale banner follows the stale rows of the result set, not the age of the last full sync (D11). */
  protected readonly banner = computed(() => {
    const freshness = this.store.freshness();
    const sync = this.sync();
    const failed = sync?.status === 'failed';
    return userFreshnessBanner({
      stale: freshness?.stale ?? 0,
      matching: this.store.page()?.matching ?? 0,
      refreshing: !!freshness?.refreshing || this.store.refreshing(),
      jobFailure: syncFailureText(this.store.jobFailure()),
      syncFailure: failed ? this.failureText() : '',
      syncFailed: failed,
    });
  });
  protected readonly label = (predicate: UserPredicate) =>
    chipLabel(predicate, this.store.attributes());
  protected readonly load = (offset: number, limit: number, view: UserView) => {
    this.store.setView(view);
    return this.store.rows(offset, limit);
  };
  protected readonly saveState = (state: GridState, selectedView: boolean) => {
    this.store.gridState.set(state);
    this.store.selectedView.set(selectedView);
  };
  protected readonly selection = {
    provider: this.store.selection,
    tabId: this.store.selectionTab,
  };
  protected readonly selectedCount = this.store.selectedCount;
  /** Bulk Actions needs both the selection and the value write (B section 11). */
  protected readonly canSetAttributes = computed(
    () =>
      this.authorized('users:write') && this.authorized('users:bulk-actions'),
  );
  protected readonly bulkOpen = signal(false);
  protected readonly bulkMenuOpen = signal(false);
  protected readonly bulkCategories = computed(
    () => this.store.categories()?.categories ?? [],
  );
  protected readonly bulkSelection = computed<UserSelectionKey>(() => ({
    gridId: USER_GRID_ID,
    tabId: this.store.selectionTab,
  }));
  protected readonly BULK_ACTIONS_LABEL = BULK_ACTIONS_LABEL;
  protected readonly BULK_SELECT_NOTE = BULK_SELECT_NOTE;
  protected readonly BULK_SET_ATTRIBUTES_LABEL = BULK_SET_ATTRIBUTES_LABEL;
  private readonly bulkButton =
    viewChild<ElementRef<HTMLButtonElement>>('bulkButton');
  /** Refresh Domain needs the Google connection check (design section 5). */
  protected readonly canDiagnose = computed(() =>
    this.authorized('connection:diagnose'),
  );
  protected readonly refreshSelectedSupport = REFRESH_SELECTED_SUPPORT;
  protected readonly refreshDomainSupport = REFRESH_DOMAIN_SUPPORT;

  ngOnInit(): void {
    void this.store.init();
  }

  ngOnDestroy(): void {
    this.store.leave();
  }

  /** The actions authorize at the connected customer's district scope (design 2.1). */
  private authorized(action: Action): boolean {
    const customerId = this.sync()?.customerId;
    return (
      !!customerId && this.auth.can(action, { kind: 'district', customerId })
    );
  }

  protected refresh(): void {
    void this.store.refreshAll();
  }

  protected refreshSelection(): void {
    void this.store.refreshSelection();
  }

  protected refreshDomain(): void {
    void this.store.refreshDomain();
  }

  protected reconnect(): void {
    void this.store.reconnect();
  }

  /** Read the status and the categories again after a failed read (R11). */
  protected retry(): void {
    void this.store.init();
  }

  /** One filter per field. A chip for a filtered field replaces that filter. */
  protected apply(predicate: UserPredicate): void {
    const index = this.editingIndex();
    const current = this.store.predicates();
    const at =
      index !== null && index < current.length
        ? index
        : current.findIndex(
            (item) => predicateFieldKey(item) === predicateFieldKey(predicate),
          );
    // The editor emits closed next. editorClosed() clears the index and restores focus.
    this.store.setPredicates(
      at === -1
        ? [...current, predicate]
        : current.map((item, position) => (position === at ? predicate : item)),
    );
  }

  protected remove(index: number): void {
    this.editingIndex.set(null);
    this.store.setPredicates(
      this.store.predicates().filter((_, position) => position !== index),
    );
  }

  protected clear(): void {
    this.editingIndex.set(null);
    // A column filter that matches no row has no chip. The grid clears it too (R6).
    this.store.clearFilters();
  }

  /** After a chip edit closes, focus returns to that chip (GRID-04, UI-09). */
  protected editorClosed(): void {
    const index = this.editingIndex();
    this.editingIndex.set(null);
    if (index === null) return;
    afterNextRender(() => this.chips()[index]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** Open the Set attributes dialog for the selection of this tab (state 08). */
  protected openSetAttributes(): void {
    if (!this.canSetAttributes() || this.selectedCount() === 0) return;
    this.bulkOpen.set(true);
  }

  /** The dialog closed. Focus returns to the Bulk Actions control (UI-09). */
  protected closeBulk(): void {
    this.bulkOpen.set(false);
    afterNextRender(() => this.bulkButton()?.nativeElement?.focus(), {
      injector: this.injector,
    });
  }

  /** GRID-03: the details control records the row, then opens that user (A section 4). */
  protected openDetails(event: {
    row: UserRow;
    index: number;
    scrollTop: number | null;
  }): void {
    this.recordRow(event);
    void this.router.navigate(['/users', event.row.userId]);
  }

  /**
   * The row that opened the details stays the return anchor. Next user moves only the
   * cursor, so Back to users returns to this row, its page, and its scroll position
   * (A section 4, R3).
   */
  protected recordRow(event: {
    row: UserRow;
    index: number;
    scrollTop: number | null;
  }): void {
    const { index } = event;
    const { userId } = event.row;
    this.store.position.set({ index, userId, scrollTop: event.scrollTop });
    this.store.cursor.set({ index, userId });
  }
}
