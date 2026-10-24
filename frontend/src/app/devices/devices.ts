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
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import type {
  Action,
  DevicePredicate,
  DeviceRow,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';
import { DeviceGrid } from './device-grid';
import { DeviceFilter } from './device-filter';
import { DeviceUpdateSheet } from './device-update-sheet';
import { DeviceActionSheet } from './device-action-sheet';
import { DeviceGridDraftStore, rowPatchFor } from './device-grid-draft.store';
import { DeviceGridRevertDialog } from './device-grid-revert-dialog';
import { DeviceOrgUnitTreeStore } from './device-org-unit-tree.store';
import { deviceActionNote } from './device-action-messages';
import { freshnessBanner } from './device-freshness';
import type { DeviceView } from './device-datasource';
import type { GridState } from 'ag-grid-community';
import {
  chipLabel,
  syncFailureText,
  telemetryFailureText,
} from './device-fields';
import {
  DEVICE_ORG_UNIT_SCOPE,
  DEVICE_WRITE_SCOPE,
  updateDeviceNote,
  updateDeviceOrgUnitNote,
  type UpdateDeviceNote,
  type UpdateDeviceNoteAction,
} from './device-update-messages';
import {
  REFRESH_DOMAIN_SUPPORT,
  REFRESH_SELECTED_SUPPORT,
} from './device-refresh-messages';
import { DeviceWriteAccessStore } from './device-write-access.store';
import { GoogleHealthStore } from '../google-connection/health.store';

/** The panel's second line while the pending view is on (mockup state 04). */
export const PENDING_VIEW_LINE =
  'Showing only devices with pending changes. Show all devices returns to your filters.';

/** The three Bulk Actions entries of the owner mockup of 2026-10-21. */
export type BulkActionKey = 'update' | 'command' | 'status';

const BULK_ACTION_KEYS: readonly BulkActionKey[] = [
  'update',
  'command',
  'status',
];

interface BulkActionNoteGroup {
  id: string;
  text: string;
  error: boolean;
  actions: readonly UpdateDeviceNoteAction[];
  keys: BulkActionKey[];
}

@Component({
  selector: 'app-devices',
  imports: [
    RouterLink,
    MatButtonModule,
    MatMenuModule,
    DeviceGrid,
    DeviceFilter,
    DeviceUpdateSheet,
    DeviceActionSheet,
    DeviceGridRevertDialog,
  ],
  templateUrl: './devices.html',
  styleUrl: './devices.css',
})
export class DevicesPage implements OnInit, OnDestroy {
  protected readonly store = inject(DevicesStore);
  protected readonly writeAccess = inject(DeviceWriteAccessStore);
  /** The grid draft of this tab and person (DRAFT-01, DRAFT-02). */
  protected readonly gridDraft = inject(DeviceGridDraftStore);
  /** The shared tree that the grid's Organization unit picker reads. */
  protected readonly orgUnitTree = inject(DeviceOrgUnitTreeStore);
  /** The one pre-filled delegation link that Diagnostics also shows. */
  protected readonly google = inject(GoogleHealthStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly chips = viewChildren<ElementRef<HTMLButtonElement>>('chip');
  private readonly bulkButton = viewChild<
    ElementRef<HTMLButtonElement>,
    ElementRef<HTMLButtonElement>
  >('bulkButton', { read: ElementRef });
  /** The grid owns the active editor that Save changes stops (addendum section 5). */
  private readonly grid = viewChild(DeviceGrid);
  protected readonly sync = this.store.sync;
  protected readonly editingIndex = signal<number | null>(null);
  protected readonly refreshMenuOpen = signal(false);
  protected readonly bulkMenuOpen = signal(false);
  protected readonly updateOpen = signal(false);
  /** The draft that the open sheet prepares: the browsing selection or the grid draft. */
  protected readonly sheetSource = signal<'selection' | 'grid'>('selection');
  protected readonly revertOpen = signal(false);
  /** The grid shows the draft's devices instead of the person's query (addendum 5). */
  protected readonly pendingView = signal(false);
  protected readonly commandOpen = signal(false);
  protected readonly statusOpen = signal(false);
  protected readonly copied = signal('');
  protected readonly editing = computed(() => {
    const index = this.editingIndex();
    return index === null ? null : (this.store.predicates()[index] ?? null);
  });
  protected readonly published = computed(() => !!this.sync()?.observedAt);
  protected readonly noMatches = computed(
    () =>
      // The pending view lists rows outside the person's filters, so they cannot empty it.
      !this.pendingView() &&
      this.store.page()?.matching === 0 &&
      this.store.predicates().length > 0 &&
      // Show All Selected keeps the grid, so its footer can return to all records.
      !this.store.view().selection,
  );
  protected readonly selection = {
    provider: this.store.selection,
    tabId: this.store.selectionTab,
    // Select All in the pending view names the rows on screen, not the whole inventory.
    pendingScope: (ids: readonly string[] | null) =>
      this.store.selection.pendingScope.set(ids),
  };
  protected readonly emptyInventory = computed(
    () =>
      this.store.page()?.total === 0 && this.store.predicates().length === 0,
  );
  protected readonly failureText = computed(() =>
    syncFailureText(this.sync()?.failure ?? null),
  );
  protected readonly telemetryText = computed(() =>
    telemetryFailureText(this.sync()?.telemetryFailure ?? null),
  );
  /** The stale banner follows the stale rows of the result set, not the age of the last full sync (D11). */
  protected readonly banner = computed(() => {
    const freshness = this.store.freshness();
    const sync = this.sync();
    const failed = sync?.status === 'failed';
    return freshnessBanner({
      stale: freshness?.stale ?? 0,
      matching: this.store.page()?.matching ?? 0,
      refreshing: !!freshness?.refreshing || this.store.refreshing(),
      jobFailure: syncFailureText(this.store.jobFailure()),
      syncFailure: failed ? this.failureText() : '',
      syncFailed: failed,
    });
  });
  protected readonly label = chipLabel;
  protected readonly load = (
    offset: number,
    limit: number,
    view: DeviceView,
  ) => {
    this.store.setView(view);
    return this.store.rows(offset, limit);
  };
  protected readonly loadGroups = (view: DeviceView) => {
    this.store.setView(view);
    return this.store.groups(view);
  };
  /**
   * The draft's devices, or null while the grid shows the person's own query. The
   * pending view lists every changed device, inside or outside the current filter.
   */
  protected readonly pendingIds = computed<readonly string[] | null>(() => {
    if (!this.pendingView()) return null;
    return [
      ...new Set(this.gridDraft.entries().map((entry) => entry.deviceId)),
    ];
  });
  protected readonly loadPending = (ids: readonly string[]) =>
    this.store.pendingRows(ids);
  /** A failed pending read names the failure and offers Try again. */
  protected readonly pendingFailure = computed(
    () => this.pendingView() && this.store.pendingFailure(),
  );
  /** The changed devices that the read found. Show all devices returns to the query. */
  protected readonly pendingEmpty = computed(
    () =>
      this.pendingView() &&
      !this.store.pendingFailure() &&
      this.store.pendingMatching() === 0,
  );
  /** A retry asks the grid for the pending rows again. */
  protected readonly pendingRevision = signal(0);
  /**
   * The panel's second line. A reason for a blocked save wins over the view's own
   * explanation, because the person must resolve it first.
   */
  protected readonly draftLine = computed(() => {
    const line = this.gridDraft.line();
    if (line.text || !this.pendingView()) return line;
    return { text: PENDING_VIEW_LINE, tone: '' as const };
  });
  /** A grouped grid cannot scroll back to a row inside a closed group. */
  protected readonly grouped = computed(
    () => !!this.store.view().group?.by.length,
  );
  protected readonly saveState = (state: GridState, selectedView: boolean) => {
    this.store.gridState.set(state);
    this.store.selectedView.set(selectedView);
  };
  protected readonly canRead = computed(() => this.authorized('devices:read'));
  protected readonly canWrite = computed(() =>
    this.authorized('devices:write'),
  );
  protected readonly canCommand = computed(() =>
    this.authorized('devices:commands'),
  );
  protected readonly canStatus = computed(() =>
    this.authorized('devices:status'),
  );
  /** Wipe user data and Powerwash hold one permission (record ruling 1). */
  protected readonly canWipe = computed(() => this.authorized('devices:wipe'));
  protected readonly canDeprovision = computed(() =>
    this.authorized('devices:deprovision'),
  );
  protected readonly canBulk = computed(() =>
    this.authorized('devices:bulk-actions'),
  );
  /** The three actions of Update device. Without them every grid cell stays read-only. */
  protected readonly gridEditable = computed(
    () => this.canRead() && this.canWrite() && this.canBulk(),
  );
  /** The route's note while the Organization unit read is not granted. */
  protected readonly orgUnitNote = computed(() =>
    this.gridEditable()
      ? updateDeviceOrgUnitNote(
          this.orgUnitTree.tree(),
          this.orgUnitTree.message(),
        )
      : null,
  );
  protected readonly canDiagnose = computed(() =>
    this.authorized('connection:diagnose'),
  );
  /** The selection that Refresh Selected reads. */
  protected readonly selectedCount = computed(
    () => this.store.selection.spec()?.selectedCount ?? 0,
  );
  protected readonly refreshSelectedSupport = REFRESH_SELECTED_SUPPORT;
  protected readonly refreshDomainSupport = REFRESH_DOMAIN_SUPPORT;
  /** The Google write-access state that every device write action reads. */
  private readonly accessState = computed(() => ({
    offline: this.store.offline(),
    canRead: this.canRead(),
    canBulk: this.canBulk(),
    selectionCount: this.store.selection.spec()?.selectedCount ?? 0,
    access: this.writeAccess.access(),
    // Before the first read starts, the note reports the pending check.
    accessLoading:
      this.writeAccess.loading() ||
      (!this.writeAccess.access() && !this.writeAccess.message()),
  }));
  /** One note per Bulk Actions entry. Each names its own missing permission. */
  protected readonly actionNotes = computed<
    Record<BulkActionKey, UpdateDeviceNote | null>
  >(() => {
    const shared = this.accessState();
    return {
      update: updateDeviceNote({ ...shared, canWrite: this.canWrite() }),
      command: deviceActionNote({
        ...shared,
        family: 'command',
        // D2: Send command enables with any command permission.
        canAction: this.canCommand() || this.canWipe(),
      }),
      status: deviceActionNote({
        ...shared,
        family: 'status',
        // D2: Change status enables with devices:status or devices:deprovision.
        canAction: this.canStatus() || this.canDeprovision(),
      }),
    };
  });
  /**
   * The notes of the disabled entries. Entries that share one reason share one
   * note, so a reader meets each reason once.
   */
  protected readonly notes = computed<BulkActionNoteGroup[]>(() => {
    const groups: BulkActionNoteGroup[] = [];
    const entries = this.actionNotes();
    for (const key of BULK_ACTION_KEYS) {
      const note = entries[key];
      if (!note) continue;
      const found = groups.find((group) => group.text === note.text);
      if (found) {
        found.keys.push(key);
        continue;
      }
      groups.push({
        id: key === 'update' ? 'bulk-note' : `bulk-note-${key}`,
        text: note.text,
        error: note.error,
        actions: note.actions,
        keys: [key],
      });
    }
    return groups;
  });
  /** The note id of each entry, or no entry when the action is enabled. */
  protected readonly describedBy = computed<
    Partial<Record<BulkActionKey, string>>
  >(() => {
    const map: Partial<Record<BulkActionKey, string>> = {};
    for (const group of this.notes())
      for (const key of group.keys) map[key] = group.id;
    return map;
  });
  /** The Bulk Actions trigger references the note of Update device. */
  protected readonly note = computed(() => this.actionNotes().update);

  /** The actions authorize at the connected customer's district scope (design 2.1). */
  private authorized(action: Action): boolean {
    const customerId = this.sync()?.customerId;
    return (
      !!customerId && this.auth.can(action, { kind: 'district', customerId })
    );
  }

  constructor() {
    // Settlement reads authoritative rows and unchanged preview values. The grid cache
    // takes them before an overlay leaves (B4).
    this.gridDraft.applyRows = (rows) => this.store.gridRows.apply(rows);
    this.gridDraft.applyValues = (values) =>
      this.store.gridRows.patch(
        values.map((value) => ({
          deviceId: value.deviceId,
          values: rowPatchFor(value.field, value.value),
        })),
      );
    effect(() => {
      this.store.revision();
      untracked(() => void this.store.loadOrgUnits());
    });
    effect(() => {
      if (
        this.canWrite() ||
        this.canCommand() ||
        this.canStatus() ||
        this.canWipe() ||
        this.canDeprovision()
      )
        untracked(() => void this.writeAccess.load());
    });
    // The pending view needs a changed device. Reverting the last change returns to the query.
    effect(() => {
      if (this.gridDraft.counts().changes > 0) return;
      untracked(() => {
        if (!this.pendingView()) return;
        this.pendingView.set(false);
        // The view boundary clears the pending count, whatever row model loads next.
        this.store.clearPending();
      });
    });
  }

  ngOnInit(): void {
    void this.store.init();
  }

  ngOnDestroy(): void {
    this.store.leave();
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

  /** Update device opens the bulk action sheet over the grid (owner, 2026-10-20). */
  protected startUpdate(): void {
    // The Bulk Actions entry prepares the browsing selection, not the grid draft.
    this.sheetSource.set('selection');
    this.updateOpen.set(true);
  }

  /**
   * Save changes stages the active editor's input, stops that editor, and opens the sheet at
   * the edit-list preview (IF3, addendum section 5). The whole set is checked after staging,
   * so a valid live value joins the save and an invalid one blocks all of it (B1).
   */
  protected saveGridDraft(): void {
    if (!this.gridDraft.visible() || this.gridDraft.blocked()) return;
    // Stage the live input before the editor closes: a stopped editor clears its value.
    this.gridDraft.commitLive();
    this.grid()?.endEdit();
    // The staging callback may have added an invalid entry, so recheck the whole set.
    if (this.gridDraft.blocked() || this.gridDraft.refusal() !== '') return;
    if (!this.gridDraft.edits().length) return;
    this.sheetSource.set('grid');
    this.updateOpen.set(true);
  }

  /** The grid source asks for the devices with pending changes (mockup state 04). */
  protected showPendingDevices(): void {
    this.pendingView.set(true);
  }

  /** Send command opens the command sheet over the grid. */
  protected startCommand(): void {
    this.commandOpen.set(true);
  }

  /** Change status opens the status sheet over the grid. */
  protected startStatus(): void {
    this.statusOpen.set(true);
  }

  /** Closing a sheet returns focus to the Bulk Actions button. */
  protected updateClosed(): void {
    this.updateOpen.set(false);
    this.focusBulkActions();
  }

  protected commandClosed(): void {
    this.commandOpen.set(false);
    this.focusBulkActions();
  }

  protected statusClosed(): void {
    this.statusOpen.set(false);
    this.focusBulkActions();
  }

  private focusBulkActions(): void {
    afterNextRender(() => this.bulkButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** Copy the scope that the denied message names (design 4.3). */
  protected async copyScope(): Promise<void> {
    const scope = this.writeAccess.access()?.scope ?? DEVICE_WRITE_SCOPE;
    if (!scope) return;
    try {
      await navigator.clipboard.writeText(scope);
      this.copied.set('Copied the Google device changes scope.');
    } catch {
      this.copied.set(
        'Clipboard access is unavailable. Select and copy the scope text.',
      );
    }
  }

  protected recheck(): void {
    void this.writeAccess.check();
  }

  /** Copy the scope that the Organization unit note names. */
  protected copyOrgUnitScope(): void {
    if (!DEVICE_ORG_UNIT_SCOPE) return;
    void navigator.clipboard.writeText(DEVICE_ORG_UNIT_SCOPE).then(
      () => this.copied.set('Copied the Google organization unit read scope.'),
      () =>
        this.copied.set(
          'Clipboard access is unavailable. Select and copy the scope text.',
        ),
    );
  }

  protected recheckOrgUnits(): void {
    void this.orgUnitTree.load();
  }

  /** Revert all changes clears the grid draft after the one question names the count. */
  protected confirmRevertAll(): void {
    this.gridDraft.revertAll();
    this.pendingView.set(false);
    this.store.clearPending();
    this.revertOpen.set(false);
    this.focusBulkActions();
  }

  /** One toggle switches between the draft's devices and the person's own query. */
  protected togglePendingView(): void {
    this.pendingView.update((active) => !active);
    // Returning to the query is the view boundary: the pending count leaves the footer.
    if (!this.pendingView()) this.store.clearPending();
  }

  /** Try again reads the pending devices once more, without touching the draft. */
  protected retryPending(): void {
    this.pendingRevision.update((value) => value + 1);
  }

  /** One filter per field. A chip for a filtered field replaces that filter. */
  protected apply(predicate: DevicePredicate): void {
    const index = this.editingIndex();
    const current = this.store.predicates();
    const at =
      index !== null && index < current.length
        ? index
        : current.findIndex((item) => item.field === predicate.field);
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
    this.store.setPredicates([]);
  }

  /** After a chip edit closes, focus returns to that chip (GRID-04). */
  protected editorClosed(): void {
    const index = this.editingIndex();
    this.editingIndex.set(null);
    if (index === null) return;
    afterNextRender(() => this.chips()[index]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected open(event: {
    row: DeviceRow;
    index: number;
    route: string[] | null;
    count: number | null;
  }): void {
    // Next device follows the opened device's group. The pending view holds rows outside
    // the person's query, so its index names no row there and sets no position.
    if (!this.pendingView()) {
      const view = this.store.view();
      if (event.route)
        this.store.view.set({
          ...view,
          group: { by: view.group?.by ?? [], keys: event.route },
        });
      this.store.position.set({
        index: event.index,
        deviceId: event.row.deviceId,
        ...(event.count === null ? {} : { count: event.count }),
      });
    }
    void this.router.navigate(['/devices', event.row.deviceId]);
  }
}
