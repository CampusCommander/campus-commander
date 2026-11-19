import {
  Component,
  DestroyRef,
  OnInit,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import type { UserAttributeCategory } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UsersStore, usersSchemaManageable } from './users.store';
import { categoryReadText } from './user-fields';
import { UserAttributeHelp } from './user-attribute-help';
import {
  ATTRIBUTE_HELP_LABEL,
  CATEGORIES_EMPTY_BODY,
  CATEGORIES_EMPTY_TITLE,
  CATEGORIES_ERROR_TITLE,
  CATEGORIES_LOADING_TEXT,
  CATEGORIES_REFRESHING_LABEL,
  CATEGORIES_REFRESH_LABEL,
  CATEGORIES_TABLE_LABEL,
  COLUMN_ATTRIBUTES,
  COLUMN_CATEGORY,
  COLUMN_CATEGORY_NAME,
  COLUMN_USERS_WITH_VALUES,
  CREATE_CATEGORY_LABEL,
  EDIT_CATEGORY_LABEL,
  countText,
  categoryLimitsText,
  editCategoryLabel,
  openCategoryLabel,
} from './user-attribute-messages';
import { UserCategoryDialog } from './user-category-dialog';
import { UserCategoryEditor } from './user-category-editor';

/**
 * The Custom attributes tab (U2, CA states 01 and 11). It lists the categories with the
 * limit counts, reads Google on Refresh (B section 9), and opens the read-only dialog of
 * state 09. Card K18 adds Create category and the editor that replaces the interim.
 */
@Component({
  selector: 'app-user-attribute-categories',
  imports: [
    MatButtonModule,
    RouterLink,
    UserAttributeHelp,
    UserCategoryDialog,
    UserCategoryEditor,
  ],
  templateUrl: './user-attribute-categories.html',
  styleUrl: './user-attribute-categories.css',
})
export class UserAttributeCategories implements OnInit {
  protected readonly store = inject(UsersStore);
  private readonly auth = inject(AuthStore);

  /** The category of the open read-only dialog, or null while the list shows. */
  protected readonly dialogCategory = signal<UserAttributeCategory | null>(
    null,
  );
  /** The open editor, its mode, and its category. Null while the list shows. */
  protected readonly editor = signal<{
    readonly mode: 'create' | 'edit';
    readonly category: UserAttributeCategory | null;
  } | null>(null);
  /** The contextual help disclosure of the page toolbar (composition choice 15). */
  protected readonly helpOpen = signal(false);
  /** The category link that opened the dialog. Focus returns to it on close (UI-09). */
  private opener: HTMLElement | null = null;
  /** The control that opened the editor. Focus returns to it on close (UI-09). */
  private editorOpener: HTMLElement | null = null;
  /** The last control that this tab focused, and the close that owns it. */
  private focusOwner: {
    readonly element: HTMLElement;
    readonly fence: number;
  } | null = null;
  /** A close that still owes the page its focus. The effect applies it after the render. */
  private readonly focusRequest = signal<{
    readonly opener: HTMLElement | null;
    readonly fence: number;
  } | null>(null);
  /** Invalidates the focus work of an older close when a dialog opens or closes. */
  private focusFence = 0;
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
    });
    afterRenderEffect(() => {
      const request = this.focusRequest();
      if (!request) return;
      // The replacement depends on the rendered list, so read it and re-run on a change.
      this.categories();
      this.failed();
      this.applyFocus(request);
    });
  }

  /** The tab shows Create category and the editor only with User Schema Manage (U4). */
  protected readonly canManage = computed(() =>
    usersSchemaManageable(this.auth),
  );
  /** The category set carries the account limits that the editor reads. */
  protected readonly limits = computed(
    () => this.store.categories()?.limits ?? null,
  );

  protected readonly ATTRIBUTE_HELP_LABEL = ATTRIBUTE_HELP_LABEL;
  protected readonly CATEGORIES_EMPTY_BODY = CATEGORIES_EMPTY_BODY;
  protected readonly CATEGORIES_EMPTY_TITLE = CATEGORIES_EMPTY_TITLE;
  protected readonly CATEGORIES_ERROR_TITLE = CATEGORIES_ERROR_TITLE;
  protected readonly CATEGORIES_LOADING_TEXT = CATEGORIES_LOADING_TEXT;
  protected readonly CATEGORIES_REFRESHING_LABEL = CATEGORIES_REFRESHING_LABEL;
  protected readonly CATEGORIES_REFRESH_LABEL = CATEGORIES_REFRESH_LABEL;
  protected readonly CATEGORIES_TABLE_LABEL = CATEGORIES_TABLE_LABEL;
  protected readonly COLUMN_ATTRIBUTES = COLUMN_ATTRIBUTES;
  protected readonly COLUMN_CATEGORY = COLUMN_CATEGORY;
  protected readonly COLUMN_CATEGORY_NAME = COLUMN_CATEGORY_NAME;
  protected readonly COLUMN_USERS_WITH_VALUES = COLUMN_USERS_WITH_VALUES;
  protected readonly CREATE_CATEGORY_LABEL = CREATE_CATEGORY_LABEL;
  protected readonly EDIT_CATEGORY_LABEL = EDIT_CATEGORY_LABEL;

  /** The categories sorted by display name, the order that the approved table draws. */
  protected readonly categories = computed<readonly UserAttributeCategory[]>(
    () =>
      [...(this.store.categories()?.categories ?? [])].sort((left, right) => {
        const order = left.displayName.localeCompare(right.displayName, 'en', {
          sensitivity: 'base',
        });
        if (order !== 0) return order;
        return left.schemaName.localeCompare(right.schemaName, 'en');
      }),
  );
  protected readonly limitsText = computed(() => {
    const limits = this.store.categories()?.limits;
    return limits ? categoryLimitsText(limits) : '';
  });
  /**
   * No answer yet: neither a category set nor a failure has arrived. The first read
   * shows this state, and a failed read moves to the error card (UI-08).
   */
  protected readonly loading = computed(
    () => !this.store.categories() && !this.store.categoriesFailure(),
  );
  /** A read failure, in the words of the tab. It names Refresh as the retry. */
  protected readonly failureText = computed(() => {
    const failure = this.store.categoriesFailure();
    return failure ? categoryReadText(failure.status, failure.failure) : '';
  });
  /** The read failed before any category arrived, so the tab shows its error card. */
  protected readonly failed = computed(
    () => !this.loading() && !this.store.categories() && !!this.failureText(),
  );
  protected readonly hasCategories = computed(
    () => this.categories().length > 0,
  );
  protected readonly refreshing = this.store.categoriesRefreshing;
  protected readonly recovery = this.store.categoriesRecovery;
  /** A failed refresh keeps the cached list and reports the failure beside it (UI-08). */
  protected readonly refreshFailed = computed(
    () => !!this.store.categories() && !!this.failureText(),
  );

  /**
   * The tab opened. The API reads `schemas.list` when the tab opens and its cache is
   * older than 24 hours (B section 9), so every activation asks. The component is
   * created by the tab panel, so a reopen asks again.
   */
  ngOnInit(): void {
    void this.store.loadCategories();
  }

  protected count(value: number): string {
    return countText(value);
  }

  protected openLabel(category: UserAttributeCategory): string {
    return this.canManage()
      ? editCategoryLabel(category.displayName)
      : openCategoryLabel(category.displayName);
  }

  /**
   * The category control opens the editor for a manager (CA state 04) and the read-only
   * dialog for every other session (CA state 09).
   */
  protected open(category: UserAttributeCategory, event: Event): void {
    const opener = event.currentTarget as HTMLElement | null;
    this.nextFocusFence();
    if (!this.canManage()) {
      this.opener = opener;
      this.dialogCategory.set(category);
      return;
    }
    this.editorOpener = opener;
    this.editor.set({ mode: 'edit', category });
  }

  /** The dialog closed. Focus returns to the category link that opened it (UI-09). */
  protected closeDialog(): void {
    this.dialogCategory.set(null);
    this.restoreFocus(this.opener, this.nextFocusFence());
    this.opener = null;
  }

  /** Create category opens the editor with no category (CA state 02). */
  protected createCategory(event: Event): void {
    this.nextFocusFence();
    this.editorOpener = event.currentTarget as HTMLElement | null;
    this.editor.set({ mode: 'create', category: null });
  }

  /**
   * The editor closed. Focus returns to the control that opened it, or to its logical
   * replacement when the list transition removed it (UI-09). The tab reads the counts
   * again because the flow may have changed the schema. The read can answer after a
   * person moved the focus or opened a successor dialog, so the second pass stays fenced
   * to this close.
   */
  protected async closeEditor(): Promise<void> {
    const opener = this.editorOpener;
    this.editorOpener = null;
    this.editor.set(null);
    const fence = this.nextFocusFence();
    this.restoreFocus(opener, fence);
    await this.store.loadCategories();
    if (this.gone || fence !== this.focusFence) return;
    // A create from the empty state or a delete replaces its opener with the list.
    this.restoreFocus(opener, fence);
  }

  /** Invalidate the focus work of an older close and drop its ownership. */
  private nextFocusFence(): number {
    this.focusFence += 1;
    this.focusOwner = null;
    return this.focusFence;
  }

  /**
   * Ask for the opener after the render. A create fills the empty state and a delete
   * removes a row, so the toolbar Create control, the empty-state Create control, or the
   * tab itself stands in for the removed opener.
   */
  private restoreFocus(opener: HTMLElement | null, fence: number): void {
    this.focusRequest.set({ opener, fence });
  }

  /**
   * Apply a close's focus after the render. Only a control that the same close set is
   * owned: focus that a person moved, or that a successor dialog holds, stays put.
   */
  private applyFocus(request: {
    readonly opener: HTMLElement | null;
    readonly fence: number;
  }): void {
    if (this.gone || request.fence !== this.focusFence) return;
    if (this.editor() !== null || this.dialogCategory() !== null) return;
    const active = document.activeElement as HTMLElement | null;
    const owned =
      !!active &&
      active !== document.body &&
      this.focusOwner?.fence === request.fence &&
      this.focusOwner.element === active;
    if (active && active !== document.body && !owned) return;
    const target = this.focusTarget(request.opener);
    if (!target) return;
    if (target !== active) target.focus();
    this.focusOwner = { element: target, fence: request.fence };
  }

  private focusTarget(opener: HTMLElement | null): HTMLElement | null {
    // Stable ids, because a view-query signal can lag the render that follows a close.
    const candidates = [
      opener,
      document.getElementById('create-category-toolbar'),
      document.getElementById('create-category-empty'),
      document.getElementById('categories-retry'),
      document.getElementById('attribute-tab'),
    ];
    return (
      candidates.find((item): item is HTMLElement => !!item?.isConnected) ??
      null
    );
  }

  protected refresh(): void {
    void this.store.refreshCategories();
  }
}
