import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { Router, RouterLink } from '@angular/router';
import type {
  Action,
  UserAttributeEdit,
  UserAttributePreview,
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
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
import { UserAttributeGridDraft } from './user-attribute-grid-draft';
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
  /** The grid draft holds the pending attribute cells (design K26). */
  protected readonly draft = inject(UserAttributeGridDraft);
  private readonly editFlow = inject(UserAttributeEditFlow);

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

  /**
   * A cell is editable only with users:write while the page is online (B section 12). The
   * draft stays visible otherwise, so a restored change is never lost.
   */
  protected readonly editable = computed(
    () => this.authorized('users:write') && !this.store.offline(),
  );

  /** Show pending changes draws the draft's users instead of the current query (DRAFT-02). */
  protected readonly pendingView = signal(false);
  /** The pending view's read failed or found no row (UI-08). */
  protected readonly pendingState = signal<
    'ready' | 'loading' | 'failed' | 'empty'
  >('ready');
  /** Increments when the person asks for the pending read again. */
  protected readonly pendingRevision = signal(0);
  protected readonly pendingIds = computed<readonly string[] | null>(() =>
    this.pendingView() ? this.draft.pendingUserIds() : null,
  );
  /**
   * One read answers the pending view: at most 500 users (design K26). The grid pages and
   * sorts the answer in the browser, so a new page sends no request.
   */
  protected readonly loadPending = async (): Promise<UserRow[] | null> => {
    this.pendingState.set('loading');
    const rows = await this.store.readRowsByIds(this.draft.pendingUserIds());
    if (rows === null) {
      this.pendingState.set('failed');
      return null;
    }
    this.pendingState.set(rows.length ? 'ready' : 'empty');
    return rows;
  };

  /** Save changes: prepare the preview, then confirm it in one step or in the dialog. */
  protected readonly saving = signal(false);
  protected readonly reviewOpen = signal(false);
  protected readonly prepared = signal<UserAttributePreview | null>(null);
  private submitted: UserAttributeEdit[] = [];
  private readonly grid = viewChild(UserGrid);
  private readonly saveButton =
    viewChild<ElementRef<HTMLButtonElement>>('saveChangesButton');
  protected readonly draftLine = computed(() => this.draft.line());

  constructor() {
    // A failed job wrote no value. A saved cell returns to the value that Google holds.
    effect(() => {
      const settled = this.store.jobSettlements();
      if (!settled.revision || !settled.failed) return;
      untracked(() => this.draft.dropSettled());
    });
    // An empty draft has no pending view to show, so the grid returns to the query.
    effect(() => {
      if (!this.pendingView() || this.draft.counts().changes) return;
      untracked(() => this.pendingView.set(false));
    });
  }

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

  /** Save changes. One pending change confirms at once, as the details card does. */
  protected saveChanges(): void {
    if (!this.editable() || this.saving()) return;
    // The open editor's input is part of the draft, so Save changes keeps a typed value.
    this.grid()?.endEdit();
    this.draft.commitLive();
    if (this.draft.blocked() || this.draft.counts().changes === 0) return;
    void this.runSave();
  }

  /** Prepare one edit-list preview, then confirm it in one step or open the dialog. */
  private async runSave(): Promise<void> {
    const edits = this.draft.edits();
    if (!edits.length) return;
    this.submitted = edits;
    this.saving.set(true);
    this.draft.clearRefusal();
    const answer = await this.editFlow.prepare(edits);
    if (!answer.ok) {
      this.saving.set(false);
      this.draft.refuse(answer.message);
      return;
    }
    const preview = answer.value;
    // One change confirms at once (owner direction, 2026-10-23, design K26).
    if (edits.length === 1 && preview.eligible === 1) {
      await this.confirmAtOnce(preview);
      return;
    }
    // The frozen rows mark a conflict cell and drop an unchanged row (B section 8.4).
    const targets = await this.editFlow.readTargets(preview.previewId);
    if (targets.ok) this.draft.applyPreview(targets.value, edits);
    this.saving.set(false);
    // Two or more changes open the Set attributes dialog at Review (design K26). A dialog
    // without an eligible row shows nothing to confirm.
    if (edits.length >= 2 && (preview.eligible > 0 || preview.conflicts > 0)) {
      this.prepared.set(preview);
      this.reviewOpen.set(true);
    }
  }

  /** Confirm the preview of one change without a review step. */
  private async confirmAtOnce(preview: UserAttributePreview): Promise<void> {
    const answer = await this.editFlow.confirm(
      preview.previewId,
      preview.manifestDigest,
    );
    this.saving.set(false);
    if (!answer.ok) {
      this.draft.refuse(answer.message);
      return;
    }
    this.acceptSubmitted();
  }

  /**
   * The dialog started the job. The entries leave the draft, and the cells keep the saved
   * values until their rows hold them (design K26).
   */
  protected reviewAccepted(): void {
    if (!this.reviewOpen()) return;
    this.acceptSubmitted();
  }

  private acceptSubmitted(): void {
    const edits = this.submitted;
    if (!edits.length) return;
    this.draft.accept(edits);
    // The users feed carries the written values (document B section 9). This read covers a
    // row of the screen that the feed misses. It never reloads the grid.
    void this.store.refreshHeldRows(this.userIdsOf(edits));
  }

  private userIdsOf(edits: readonly UserAttributeEdit[]): string[] {
    return [...new Set(edits.map((edit) => edit.userId))];
  }

  /** The dialog closed. Focus returns to Save changes (UI-09). */
  protected closeReview(): void {
    this.reviewOpen.set(false);
    this.prepared.set(null);
    afterNextRender(() => this.saveButton()?.nativeElement?.focus(), {
      injector: this.injector,
    });
  }

  /** Show pending changes draws the draft's users instead of the current query. */
  protected togglePendingView(): void {
    if (this.pendingView()) {
      this.pendingView.set(false);
      return;
    }
    if (!this.draft.counts().changes) return;
    this.grid()?.endEdit();
    this.pendingState.set('loading');
    this.pendingView.set(true);
  }

  /** Read the pending view again after a failed read (UI-08). */
  protected retryPending(): void {
    this.pendingRevision.update((value) => value + 1);
  }

  /** Revert all changes: every entry leaves the draft and the bar closes. */
  protected revertAll(): void {
    this.grid()?.endEdit();
    this.draft.revertAll();
    this.pendingView.set(false);
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
