import {
  Component,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import type { UserAttributeCategory } from '@campus/application-contracts';
import { UsersStore } from './users.store';
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
  countText,
  categoryLimitsText,
  openCategoryLabel,
} from './user-attribute-messages';
import { UserCategoryDialog } from './user-category-dialog';

/**
 * The Custom attributes tab (U2, CA states 01 and 11). It lists the categories with the
 * limit counts, reads Google on Refresh (B section 9), and opens the read-only dialog of
 * state 09. Card K18 adds Create category and the edit controls.
 */
@Component({
  selector: 'app-user-attribute-categories',
  imports: [MatButtonModule, RouterLink, UserAttributeHelp, UserCategoryDialog],
  templateUrl: './user-attribute-categories.html',
  styleUrl: './user-attribute-categories.css',
})
export class UserAttributeCategories implements OnInit {
  protected readonly store = inject(UsersStore);
  private readonly injector = inject(Injector);

  /** The category of the open read-only dialog, or null while the list shows. */
  protected readonly dialogCategory = signal<UserAttributeCategory | null>(
    null,
  );
  /** The contextual help disclosure of the page toolbar (composition choice 15). */
  protected readonly helpOpen = signal(false);
  /** The category link that opened the dialog. Focus returns to it on close (UI-09). */
  private opener: HTMLElement | null = null;

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
    return openCategoryLabel(category.displayName);
  }

  protected open(category: UserAttributeCategory, event: Event): void {
    this.opener = event.currentTarget as HTMLElement | null;
    this.dialogCategory.set(category);
  }

  /** The dialog closed. Focus returns to the category link that opened it (UI-09). */
  protected closeDialog(): void {
    this.dialogCategory.set(null);
    afterNextRender(() => this.opener?.focus(), {
      injector: this.injector,
    });
  }

  protected refresh(): void {
    void this.store.refreshCategories();
  }
}
