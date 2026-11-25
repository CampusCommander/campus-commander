import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import type { UserDetail } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UsersStore } from './users.store';
import {
  STATUS_LABELS,
  TWO_STEP_LABELS,
  statusValue,
  twoStepValue,
  userName,
} from './user-fields';
import {
  rawAttributeSections,
  userAttributeSections,
} from './user-attribute-sections';
import {
  ATTRIBUTE_FAILED_TEXT,
  ATTRIBUTE_PARTIAL_TEXT,
  ATTRIBUTE_UNSETTLED_TEXT,
  attributeSavedText,
} from './user-attribute-edit-messages';
import {
  UserAttributeEditor,
  type UserAttributeSaveResult,
} from './user-attribute-editor';

/** What the page shows, from the directory status and the record read (A section 11). */
type DetailView =
  | 'loading'
  | 'error'
  | 'connection'
  | 'offline'
  | 'denied'
  | 'failed'
  | 'missing'
  | 'ready';

/** The record read, from the directory status and the last answer. */
type DetailStatus =
  | 'loading'
  | 'ready'
  | 'missing'
  | 'offline'
  | 'denied'
  | 'failed';

/** The age of one observation, for the stale and removed states (UI-06). */
export function readAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The user details page (A section 9). It reads the cached record, shows the Account,
 * Organization, and read-only Custom attributes cards, and walks the filtered order
 * with Next user (A section 4).
 */
@Component({
  selector: 'app-user-detail',
  imports: [DatePipe, RouterLink, MatButtonModule, UserAttributeEditor],
  templateUrl: './user-detail.html',
  styleUrl: './user-detail.css',
})
export class UserDetailPage {
  readonly userId = input.required<string>();
  protected readonly store = inject(UsersStore);
  private readonly router = inject(Router);
  protected readonly user = signal<UserDetail | null>(null);
  protected readonly busy = signal(false);
  private readonly status = signal<DetailStatus>('loading');
  protected readonly view = computed<DetailView>(() => {
    if (this.store.statusError()) return 'error';
    if (!this.store.syncLoaded()) return 'loading';
    if (!this.store.sync()) return 'connection';
    return this.status();
  });
  /** Next user walks the cursor of the filtered order, not the return anchor (A section 4). */
  protected readonly hasNext = computed(() => {
    const cursor = this.store.cursor();
    const matching = this.store.page()?.matching ?? null;
    return (
      cursor !== null &&
      cursor.userId === this.userId() &&
      matching !== null &&
      cursor.index + 1 < matching
    );
  });
  /**
   * The card sections. A failed category read shows the raw category and attribute
   * keys beside the scope message (A section 11, "Missing Google scope").
   */
  protected readonly sections = computed(() => {
    const current = this.user();
    if (!current) return [];
    const categories = this.store.categories();
    return categories
      ? userAttributeSections(categories.categories, current.customSchemas)
      : rawAttributeSections(current.customSchemas);
  });
  protected readonly relative = readAge;
  private readonly auth = inject(AuthStore);
  /** The card form edits every attribute of this user at once, and one save makes one job. */
  protected readonly editing = signal(false);
  protected readonly saved = signal<UserAttributeSaveResult | null>(null);
  protected readonly categories = computed(
    () => this.store.categories()?.categories ?? [],
  );
  /** A person without `users:write` sees no Edit button (card scope, design K25). */
  protected readonly canEdit = computed(() => {
    const sync = this.store.sync();
    return (
      sync !== null &&
      this.store.categories() !== null &&
      this.auth.can('users:write', {
        kind: 'district',
        customerId: sync.customerId,
      })
    );
  });
  /** The saved line of composition 13, with the job ID as a secondary link. */
  protected readonly savedLine = computed(() => {
    const result = this.saved();
    if (!result) return null;
    const text =
      result.outcome === 'saved'
        ? attributeSavedText(result.attributeNames)
        : result.outcome === 'partial'
          ? ATTRIBUTE_PARTIAL_TEXT
          : result.outcome === 'unsettled'
            ? ATTRIBUTE_UNSETTLED_TEXT
            : ATTRIBUTE_FAILED_TEXT;
    return { outcome: result.outcome, text, displayId: result.displayId };
  });
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly editButton = viewChild('editButton', { read: ElementRef });
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** The page starts focus at its heading once, when the first state replaces the skeleton. */
  private placed = false;
  /** Bumps per Next user request, so only the last request may navigate (R2). */
  private nextSequence = 0;
  /** The page ended. A read or a neighbor answer that lands later changes nothing. */
  private leaving = false;

  constructor() {
    effect(() => {
      const id = this.userId();
      untracked(() => void this.load(id));
    });
    // The grid hands over with a link that leaves the page, so focus continues at the
    // heading of the state that replaces the skeleton (UI-09).
    effect(() => {
      const view = this.view();
      this.user();
      if (this.placed || view === 'loading') return;
      this.placed = true;
      afterNextRender(() => this.heading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
    // Back to users, browser Back, and shell navigation all end this page. A deferred
    // Next answer must not navigate after that (R2).
    this.destroyRef.onDestroy(() => {
      this.leaving = true;
      this.nextSequence++;
    });
  }

  private async load(id: string): Promise<void> {
    // A direct link opens without the Users page, so the status and the categories read here.
    if (!this.store.sync() && !this.store.syncLoaded())
      void this.store.loadSync();
    if (!this.store.categories() && !this.store.categoriesError())
      void this.store.loadCategories();
    // Keep the current user visible while the next one loads, so focus stays on Next user.
    if (!this.user()) this.status.set('loading');
    this.busy.set(true);
    const read = await this.store.user(id);
    // A later route owns the page, or the answer belongs to the person who left (R1).
    if (this.userId() !== id || read.kind === 'stale') return;
    this.busy.set(false);
    if (read.kind === 'user') {
      this.user.set(read.user);
      this.status.set('ready');
      return;
    }
    // A failed read is not a missing record. Each answer keeps its own state (R5).
    this.user.set(null);
    this.status.set(read.kind);
  }

  protected retry(): void {
    void this.load(this.userId());
  }

  /** A failed status read retries through the store, then the page reads its record again. */
  protected retryStatus(): void {
    void this.store.loadSync().then(() => this.load(this.userId()));
  }

  /**
   * Next user follows the filtered order of the grid that opened this page. The page
   * moves the cursor and leaves the return anchor in place (A section 4). A neighbor
   * answer that lands after the page ended, after another navigation, or after a later
   * Next must not navigate (R2).
   */
  protected async next(): Promise<void> {
    const cursor = this.store.cursor();
    if (!cursor || cursor.userId !== this.userId()) return;
    const sequence = ++this.nextSequence;
    const from = cursor.userId;
    const row = await this.store.neighbor(cursor.index + 1);
    if (this.leaving || sequence !== this.nextSequence) return;
    if (this.userId() !== from) return;
    const current = this.store.cursor();
    if (!current || current.userId !== from) return;
    if (!row) return;
    this.store.cursor.set({ index: cursor.index + 1, userId: row.userId });
    await this.router.navigate(['/users', row.userId]);
  }

  protected startEdit(): void {
    this.saved.set(null);
    this.editing.set(true);
  }

  /** Cancel and a finished save both return focus to the Edit button (UI-09). */
  protected cancelEdit(): void {
    this.editing.set(false);
    this.focusEdit();
  }

  protected finishEdit(result: UserAttributeSaveResult): void {
    this.editing.set(false);
    this.saved.set(result);
    this.focusEdit();
    // The job settled, so the card reads the new values from the directory.
    void this.load(this.userId());
  }

  private focusEdit(): void {
    afterNextRender(() => this.editButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected title(current: UserDetail): string {
    return userName(current);
  }

  protected statusLabel(current: UserDetail): string {
    return STATUS_LABELS[statusValue(current)];
  }

  protected twoStepLabel(current: UserDetail): string {
    return TWO_STEP_LABELS[twoStepValue(current)];
  }

  protected lastSignIn(current: UserDetail): string {
    return current.lastLoginTime
      ? new Date(current.lastLoginTime).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Never';
  }

  protected created(current: UserDetail): string {
    return current.creationTime
      ? new Date(current.creationTime).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'Not set';
  }
}
