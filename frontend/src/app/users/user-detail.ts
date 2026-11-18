import {
  Component,
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

/** What the page shows, from the directory status and the record read (A section 11). */
type DetailView =
  | 'loading'
  | 'error'
  | 'connection'
  | 'offline'
  | 'missing'
  | 'ready';

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
  imports: [DatePipe, RouterLink, MatButtonModule],
  templateUrl: './user-detail.html',
  styleUrl: './user-detail.css',
})
export class UserDetailPage {
  readonly userId = input.required<string>();
  protected readonly store = inject(UsersStore);
  private readonly router = inject(Router);
  protected readonly user = signal<UserDetail | null>(null);
  protected readonly busy = signal(false);
  private readonly status = signal<'loading' | 'ready' | 'missing' | 'offline'>(
    'loading',
  );
  protected readonly view = computed<DetailView>(() => {
    if (this.store.statusError()) return 'error';
    if (!this.store.syncLoaded()) return 'loading';
    if (!this.store.sync()) return 'connection';
    return this.status();
  });
  /** Next user needs the row index of the opened user in the counted order (A section 4). */
  protected readonly hasNext = computed(() => {
    const position = this.store.position();
    const matching = this.store.page()?.matching ?? null;
    return (
      position !== null &&
      position.userId === this.userId() &&
      matching !== null &&
      position.index + 1 < matching
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
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly injector = inject(Injector);
  /** The page starts focus at its heading once, when the first state replaces the skeleton. */
  private placed = false;

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
    const user = await this.store.user(id);
    if (this.userId() !== id) return;
    this.busy.set(false);
    this.user.set(user);
    this.status.set(
      user ? 'ready' : this.store.offline() ? 'offline' : 'missing',
    );
  }

  protected retry(): void {
    void this.load(this.userId());
  }

  /** A failed status read retries through the store, then the page reads its record again. */
  protected retryStatus(): void {
    void this.store.loadSync().then(() => this.load(this.userId()));
  }

  /** Next user follows the filtered order of the grid that opened this page. */
  protected async next(): Promise<void> {
    const position = this.store.position();
    if (!position || position.userId !== this.userId()) return;
    const row = await this.store.neighbor(position.index + 1);
    if (!row) return;
    this.store.position.set({
      index: position.index + 1,
      userId: row.userId,
    });
    await this.router.navigate(['/users', row.userId]);
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
