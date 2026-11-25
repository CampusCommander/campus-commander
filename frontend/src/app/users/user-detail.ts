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
  ATTRIBUTE_EDIT_LABEL,
  ATTRIBUTE_FAILED_TEXT,
  ATTRIBUTE_JOB_SEPARATOR,
  ATTRIBUTE_PARTIAL_TEXT,
  ATTRIBUTE_REVIEW_TEXT,
  ATTRIBUTE_UNSETTLED_TEXT,
  attributeSavedText,
} from './user-attribute-edit-messages';
import {
  UserAttributeEditor,
  type UserAttributeSaveResult,
} from './user-attribute-editor';
import { UserAttributeConfirmationStore } from './user-attribute-confirmation';
import {
  UserAttributeEditFlow,
  attributeJobOutcome,
  isTerminalJobStatus,
  type AttributeSaveOutcome,
} from './user-attribute-edit-flow';

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
  /** The user of the record on screen. A replacement read keeps the previous record visible. */
  protected readonly displayedUserId = computed(
    () => this.user()?.userId ?? null,
  );
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
  /** The one Edit control and the saved-line separator of the card (compositions 4 and 13). */
  protected readonly editLabel = ATTRIBUTE_EDIT_LABEL;
  protected readonly jobSeparator = ATTRIBUTE_JOB_SEPARATOR;
  private readonly auth = inject(AuthStore);
  /** The card form edits every attribute of this user at once, and one save makes one job. */
  protected readonly editing = signal(false);
  /** The user whose card opened the form. A route change closes the form (R1-A). */
  protected readonly editingUserId = signal<string | null>(null);
  /**
   * The form is open on the card that is on screen and on the current route. A replacement
   * read keeps the previous record visible, so the route alone cannot name the owner (R2-A).
   */
  protected readonly editingThisCard = computed(
    () =>
      this.editing() &&
      this.editingUserId() !== null &&
      this.editingUserId() === this.displayedUserId() &&
      this.editingUserId() === this.userId(),
  );
  protected readonly saved = signal<UserAttributeSaveResult | null>(null);
  private readonly savedUserId = signal<string | null>(null);
  private readonly editFlow = inject(UserAttributeEditFlow);
  private readonly confirmations = inject(UserAttributeConfirmationStore);
  /**
   * The accepted receipts whose job reads continue after the editor closed (R2-C, R4-A).
   * A token lets one owner take observation over from another without two readers.
   */
  private readonly following = new Map<
    string,
    { result: UserAttributeSaveResult; token: number }
  >();
  private followSequence = 0;
  protected readonly categories = computed(
    () => this.store.categories()?.categories ?? [],
  );
  /** A person without `users:write` sees no Edit button (card scope, design K25). */
  protected readonly canEdit = computed(() => {
    const sync = this.store.sync();
    return (
      sync !== null &&
      this.store.categories() !== null &&
      // The card on screen must be the user of the route, so a held replacement read never
      // opens a form whose target differs from the heading (R2-A).
      this.displayedUserId() === this.userId() &&
      this.auth.can('users:write', {
        kind: 'district',
        customerId: sync.customerId,
      })
    );
  });
  /** The saved line of composition 13, with the job ID as a secondary link. */
  protected readonly savedLine = computed(() => {
    const result = this.saved();
    if (
      !result ||
      this.savedUserId() !== this.userId() ||
      this.savedUserId() !== this.displayedUserId()
    )
      return null;
    const text =
      result.outcome === 'saved'
        ? attributeSavedText(result.attributeNames)
        : result.outcome === 'partial'
          ? ATTRIBUTE_PARTIAL_TEXT
          : result.outcome === 'unknown'
            ? ATTRIBUTE_REVIEW_TEXT
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
      untracked(() => {
        // A draft, a result, and a pending callback belong to the user whose card opened
        // them. A route change closes the form instead of moving its state (R1-A).
        if (this.editingUserId() !== id) {
          this.editing.set(false);
          this.editingUserId.set(null);
        }
        if (this.savedUserId() !== id) this.saved.set(null);
        void this.load(id);
      });
    });
    // A replacement read keeps the previous record visible. A form for that record closes
    // when another record takes its place, so the editor owner and the heading stay aligned
    // (R2-A).
    effect(() => {
      const displayed = this.displayedUserId();
      untracked(() => {
        const owner = this.editingUserId();
        if (
          this.editing() &&
          owner !== null &&
          displayed !== null &&
          owner !== displayed
        ) {
          this.editing.set(false);
          this.editingUserId.set(null);
        }
      });
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
    const displayed = this.user();
    // Only the card on screen opens a form, and its record must be the user of the route.
    // A held replacement read can show another record, so the heading and the write target
    // never separate (R2-A).
    if (!displayed || displayed.userId !== this.userId()) return;
    // The form takes over observation of this card's accepted receipt, so one job has one
    // reader. The store keeps the receipt if the form closes again (R4-A).
    this.stopFollowing(displayed.userId);
    this.saved.set(null);
    this.savedUserId.set(null);
    this.editingUserId.set(displayed.userId);
    this.editing.set(true);
  }

  /** Cancel and a finished save both return focus to the Edit button (UI-09). */
  protected cancelEdit(): void {
    const userId = this.editingUserId();
    this.editing.set(false);
    this.editingUserId.set(null);
    // The form may have closed while it observed an accepted receipt. The card resumes the
    // same observation, and the store keeps the receipt for the next Edit (R4-A).
    if (userId) this.resumeRetained(userId);
    this.focusEdit();
  }

  protected finishEdit(result: UserAttributeSaveResult): void {
    // The save belongs to the card that started it. A later route never shows its result.
    if (
      result.userId !== this.userId() ||
      result.userId !== this.displayedUserId()
    )
      return;
    this.editing.set(false);
    this.editingUserId.set(null);
    this.savedUserId.set(result.userId);
    this.saved.set(result);
    this.focusEdit();
    // A settled job reads the new values from the directory. A job that did not settle keeps
    // its accepted receipt under observation until it answers (R2-C).
    if (result.outcome === 'unsettled') this.followJob(result);
    else void this.load(result.userId);
  }

  /** Keep reading the accepted receipt after the editor closed, and refresh on settlement. */
  private followJob(result: UserAttributeSaveResult): void {
    if (this.following.has(result.displayId)) return;
    const token = ++this.followSequence;
    this.following.set(result.displayId, { result, token });
    void this.observeJob(result, token);
  }

  /** The form of this card now observes the receipt, so the card stops its own reads. */
  private stopFollowing(userId: string): void {
    for (const [displayId, entry] of this.following)
      if (entry.result.userId === userId) this.following.delete(displayId);
  }

  /** Resume observation of a receipt that a closed form left in the store (R4-A). */
  private resumeRetained(userId: string): void {
    const entry = this.confirmations.pending(userId);
    if (!entry || entry.phase !== 'accepted' || !entry.displayId) return;
    this.followJob({
      outcome: 'unsettled',
      userId: entry.userId,
      displayId: entry.displayId,
      attributeNames: [...entry.attributeNames],
    });
  }

  private async observeJob(
    result: UserAttributeSaveResult,
    token: number,
  ): Promise<void> {
    const active = () =>
      !this.leaving && this.following.get(result.displayId)?.token === token;
    while (active()) {
      const job = await this.editFlow.readJob(result.displayId);
      if (!active()) return;
      if (job.ok && isTerminalJobStatus(job.value.status)) {
        this.following.delete(result.displayId);
        // The save settled, so its retained identity may release (R4-A).
        this.confirmations.resolveReceipt(result.displayId);
        this.settleJob(result, attributeJobOutcome(job.value.status));
        return;
      }
      // A transient read keeps the same receipt, and the next read tries again.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private settleJob(
    result: UserAttributeSaveResult,
    outcome: AttributeSaveOutcome,
  ): void {
    if (
      this.savedUserId() === result.userId &&
      this.saved()?.displayId === result.displayId
    )
      this.saved.set({ ...result, outcome });
    if (this.userId() === result.userId) void this.load(result.userId);
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
