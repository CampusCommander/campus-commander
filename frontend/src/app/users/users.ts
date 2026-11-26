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
import {
  UserAttributeConfirmationStore,
  type PendingAttributeConfirmation,
} from './user-attribute-confirmation';
import {
  UserAttributeEditFlow,
  attributeJobOutcome,
} from './user-attribute-edit-flow';
import { UserAttributeGridDraft } from './user-attribute-grid-draft';
import {
  ATTRIBUTE_CREATING_JOB_TEXT,
  ATTRIBUTE_UNSETTLED_TEXT,
} from './user-attribute-edit-messages';
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
  /** The confirmation that outlives the editor or the page (design K25, R1-B). */
  private readonly confirmations = inject(UserAttributeConfirmationStore);

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
  private readonly grid = viewChild(UserGrid);
  private readonly saveButton =
    viewChild<ElementRef<HTMLButtonElement>>('saveChangesButton');
  /**
   * One confirmation key for every save of this tab. The receipt then survives the
   * dialog, the page, and a new Save (design K25, R1-B).
   */
  protected readonly gridScope = `grid:${this.store.selectionTab}`;
  /** The retained confirmation of the grid's own save, or null. */
  protected readonly gridConfirmation = computed(() =>
    this.confirmations.pending(this.gridScope),
  );
  /** The page ended. A late job answer must not touch the draft (R1-C). */
  private destroyed = false;
  /** The jobs that this page already observes, so one job has one reader. */
  private readonly observing = new Set<string>();
  /** The accepted job that this page already settled into the draft. */
  private acceptedJob: string | null = null;
  /** The confirmation phase that this page already applied. */
  private handledConfirmation = '';
  /** The bar line: a refusal, a rule, or the state of the owned job. */
  protected readonly draftLine = computed(() => {
    const line = this.draft.line();
    if (line.tone) return line;
    const pending = this.gridConfirmation();
    if (pending?.phase === 'confirming')
      return { text: ATTRIBUTE_CREATING_JOB_TEXT, tone: '' as const };
    if (pending?.phase === 'uncertain')
      return { text: pending.message, tone: 'warning' as const };
    if (pending?.phase === 'accepted')
      return { text: ATTRIBUTE_UNSETTLED_TEXT, tone: '' as const };
    return line;
  });

  constructor() {
    // The confirmation store owns the frozen preview and the accepted receipt. A reopened
    // page continues the same save instead of preparing another one (R1-B, R1-C).
    effect(() => {
      const entry = this.gridConfirmation();
      if (!entry) return;
      untracked(() => this.applyConfirmation(entry));
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
    this.destroyed = true;
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
    // A save of this tab that has not settled yet owns the next answer. Resume it
    // instead of preparing a second preview (R1-B).
    const pending = this.gridConfirmation();
    if (pending) {
      this.recoverSave(pending);
      return;
    }
    if (this.draft.blocked() || this.draft.counts().changes === 0) return;
    void this.runSave();
  }

  /** Prepare one edit-list preview, then confirm it in one step or open the dialog. */
  private async runSave(): Promise<void> {
    const edits = this.draft.edits();
    if (!edits.length) return;
    this.saving.set(true);
    this.draft.clearRefusal();
    const answer = await this.editFlow.prepare(edits);
    this.saving.set(false);
    if (this.destroyed) return;
    if (!answer.ok) {
      this.draft.refuse(answer.message);
      return;
    }
    const preview = answer.value;
    // The frozen edit list travels with the preview, so recovery compares against this
    // list and the one-step decision counts what Save actually sent (R2-B, R2-E).
    this.confirmations.retainEdits(preview.previewId, edits);
    this.prepared.set(preview);
    // One pending change confirms at once when the preview reads one eligible row
    // (owner direction, 2026-10-23, design K26). A conflict or unchanged answer still
    // reads its frozen row first, so a single conflict blocks Save (acceptance 3).
    if (edits.length === 1 && isSinglePreview(preview)) {
      await this.confirmPrepared(preview, edits);
      return;
    }
    // A failed target read keeps the draft and names the answer (R1-J). The grid never
    // claims a conflict that it did not read. The busy flag blocks a second Save.
    this.saving.set(true);
    const targets = await this.editFlow.readTargets(preview.previewId);
    this.saving.set(false);
    if (this.destroyed) return;
    if (!targets.ok) {
      this.draft.refuse(targets.message);
      return;
    }
    // The frozen rows mark a conflict cell and drop an unchanged row (B section 8.4).
    const unchanged = this.draft.applyPreview(targets.value, edits);
    // An unchanged row holds the preview's current value, so read the on-screen row.
    if (unchanged.length) void this.store.refreshHeldRows(unchanged);
    // A single edit that the preview did not read as one eligible row follows that
    // answer: a conflict blocks Save and an unchanged row leaves the draft.
    if (edits.length === 1) return;
    // Two or more changes open the Set attributes dialog at Review (design K26). The
    // dialog shows a conflict row, and the grid's Save stays disabled afterwards (R1-C).
    if (preview.eligible > 0 || preview.conflicts > 0) {
      this.reviewOpen.set(true);
    }
  }

  /** Confirm one prepared preview and hand its receipt to the page. */
  private async confirmPrepared(
    preview: UserAttributePreview,
    edits: readonly UserAttributeEdit[],
    names: readonly string[] = this.attributeNamesOf(edits),
  ): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.draft.clearRefusal();
    // An earlier send may still own an unknown acceptance. A later definite refusal must
    // not release that identity, or the person could prepare a second job (R2-D).
    const unresolved = this.confirmations.isPending(preview.previewId);
    // Record the frozen identity before the first send (R1-B).
    this.confirmations.begin(this.gridScope, preview, names);
    const answer = await this.editFlow.confirm(
      preview.previewId,
      preview.manifestDigest,
    );
    this.saving.set(false);
    if (!answer.ok) {
      // Record the answer in the retained owner before any component-local guard. A page
      // that navigated away cannot strand the save at `confirming` (R2-A).
      if (answer.uncertain || unresolved) {
        // The answer may have created the job. Keep the preview and its digest, so the
        // next Save replays this confirmation instead of preparing another (R1-B, R2-D).
        this.confirmations.uncertain(
          this.gridScope,
          preview,
          names,
          answer.message,
        );
        if (this.destroyed) return;
        this.draft.refuse(answer.message);
        return;
      }
      this.confirmations.refuse(this.gridScope, preview, names, answer.message);
      if (this.destroyed) return;
      this.confirmations.resolve(preview.previewId);
      this.draft.refuse(answer.message);
      return;
    }
    this.confirmations.accept(
      this.gridScope,
      preview,
      names,
      answer.value.displayId,
    );
    if (this.destroyed) return;
    this.acceptSubmitted(answer.value.displayId, edits);
  }

  /** Bring the page in line with a confirmation that outlived its editor (R1-B). */
  private applyConfirmation(entry: PendingAttributeConfirmation): void {
    const key = `${entry.preview.previewId}:${entry.phase}:${entry.displayId ?? ''}`;
    if (key === this.handledConfirmation) return;
    this.handledConfirmation = key;
    if (entry.phase === 'refused') {
      this.draft.refuse(entry.message);
      this.confirmations.resolve(entry.preview.previewId);
      return;
    }
    if (entry.phase === 'confirming') return;
    if (entry.phase === 'accepted') {
      // The draft left its entries at acceptance. A reopened page applies that same
      // acceptance from the frozen list, then observes the owned job (R2-A, R2-B).
      if (entry.displayId) this.acceptSubmitted(entry.displayId, entry.edits);
      if (entry.edits.length > 1) {
        this.prepared.set(entry.preview);
        this.reviewOpen.set(true);
      }
      return;
    }
    // An uncertain answer may have created the job. Keep the preview and its digest;
    // the person's next Save replays it, and the bar names the answer (R1-B).
    this.prepared.set(entry.preview);
    if (entry.edits.length > 1) this.reviewOpen.set(true);
  }

  /** Retry or resume the save that this tab already sent. */
  private recoverSave(entry: PendingAttributeConfirmation): void {
    if (entry.phase === 'refused') {
      this.confirmations.resolve(entry.preview.previewId);
      void this.runSave();
      return;
    }
    // A confirmation that is still in flight has its own answer owner.
    if (entry.phase === 'confirming') return;
    if (entry.phase === 'uncertain') {
      this.prepared.set(entry.preview);
      // The frozen list decides the one-step path, not a later draft count (R2-E).
      if (entry.edits.length <= 1)
        void this.confirmPrepared(
          entry.preview,
          entry.edits,
          entry.attributeNames,
        );
      else this.reviewOpen.set(true);
      return;
    }
    if (entry.displayId) this.acceptSubmitted(entry.displayId, entry.edits);
  }

  /**
   * The dialog started the job. The entries leave the draft, and the cells keep the saved
   * values until their owning job and their rows answer (design K26).
   */
  protected reviewAccepted(displayId: string): void {
    if (this.reviewOpen()) {
      const entry = this.gridConfirmation();
      if (entry?.displayId === displayId) {
        this.acceptSubmitted(displayId, entry.edits);
      }
      return;
    }
    // A save from the toolbar's Set attributes setup. The grid shows the written rows
    // after the dialog closes, through one read of the held rows (R1-C).
    void this.observeReceipt(displayId, [], 'selection');
  }

  private acceptSubmitted(
    displayId: string,
    edits: readonly UserAttributeEdit[],
  ): void {
    if (this.acceptedJob === displayId) return;
    this.acceptedJob = displayId;
    this.draft.accept(edits, displayId);
    void this.observeReceipt(displayId, edits, 'draft');
  }

  /**
   * Follow one accepted receipt to its terminal answer. A completed job keeps the
   * submitted value until an authoritative row lands, and a failed or unknown job returns
   * the cell to its row at once. The final read covers a feed publication that the grid
   * missed, and it never reloads the grid (R1-C).
   */
  private async observeReceipt(
    displayId: string | null,
    edits: readonly UserAttributeEdit[],
    source: 'draft' | 'selection',
  ): Promise<void> {
    if (!displayId || this.observing.has(displayId)) return;
    this.observing.add(displayId);
    const answer = await this.editFlow.waitForJob(
      displayId,
      120,
      1000,
      () => this.destroyed,
    );
    this.observing.delete(displayId);
    if (this.destroyed) return;
    // A job that still runs keeps its receipt. The next Save or the next page resumes it.
    if (!answer.ok) return;
    this.confirmations.resolveReceipt(displayId);
    if (source === 'selection') {
      await this.store.refreshHeldRowsOnScreen();
      return;
    }
    this.draft.settleJob(displayId, attributeJobOutcome(answer.value.status));
    if (edits.length) await this.store.refreshHeldRows(this.userIdsOf(edits));
    else await this.store.refreshHeldRowsOnScreen();
  }

  /** The rule labels of one save, for the retained confirmation. */
  private attributeNamesOf(edits: readonly UserAttributeEdit[]): string[] {
    const labels = new Map(
      this.draft
        .entries()
        .map((entry) => [entry.attribute, entry.label] as const),
    );
    return [
      ...new Set(
        edits.map((edit) => labels.get(edit.attribute) ?? edit.attribute),
      ),
    ];
  }

  private userIdsOf(edits: readonly UserAttributeEdit[]): string[] {
    return [...new Set(edits.map((edit) => edit.userId))];
  }

  /** The dialog closed. Focus returns to Save changes (UI-09). */
  protected closeReview(): void {
    this.reviewOpen.set(false);
    // A preview stays while its confirmation needs recovery. Only a refused or settled
    // answer releases the caller's prepared preview (R1-B).
    const pending = this.gridConfirmation();
    if (!pending || pending.phase === 'refused') this.prepared.set(null);
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

/** Whether one preview reads one eligible row, so one change confirms at once. */
function isSinglePreview(preview: UserAttributePreview): boolean {
  return (
    preview.attributeChanges === 1 &&
    preview.eligible === 1 &&
    preview.conflicts === 0 &&
    preview.unchanged === 0
  );
}
