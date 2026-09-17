import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { z } from 'zod';
import {
  schoolPreviewSchema,
  schoolReviewSchema,
  type SchoolDefinition,
  type SchoolReview,
} from '@campus/application-contracts';
import { SchoolsStore } from './schools.store';
import { OuReferencePicker } from './ou-reference-picker';

const rule = z.object({
  id: z.string().min(1).max(128),
  descendants: z.boolean(),
});
const draftSchema = z.object({
  schoolId: z.uuid(),
  customerId: z.string(),
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().max(256),
  rules: z.object({
    include: z.array(rule).max(128),
    exclude: z.array(rule).max(128),
  }),
});
const pendingSchema = z.object({
  input: schoolPreviewSchema,
  stage: z.enum(['preview', 'review', 'confirm']),
  actorVersion: z.number().int().positive(),
});
const savedSchema = z.object({
  draft: draftSchema,
  pending: pendingSchema.nullable(),
  receipt: schoolReviewSchema.nullable().default(null),
});
type Draft = z.infer<typeof draftSchema>;
type Pending = z.infer<typeof pendingSchema>;

@Component({
  selector: 'app-school-editor',
  imports: [
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    OuReferencePicker,
  ],
  templateUrl: './school-editor.html',
  styleUrl: './schools.css',
})
export class SchoolEditor implements OnDestroy {
  readonly store = inject(SchoolsStore);
  readonly saved = output<string>();
  readonly closed = output<void>();
  readonly namePattern = '(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+';
  readonly draft = signal<Draft | null>(null);
  readonly pending = signal<Pending | null>(null);
  readonly review = signal<SchoolReview | null>(null);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly storageError = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly descendants = signal(true);
  readonly confirmed = signal(false);
  readonly conflict = signal(false);
  readonly reviewExpired = computed(
    () =>
      !!this.review() &&
      Date.parse(this.review()!.expiresAt) <= this.store.now(),
  );
  readonly selected = computed(
    () =>
      this.store
        .references()
        ?.observation?.units.find((unit) => unit.id === this.selectedId()) ??
      null,
  );
  readonly writable = computed(() => {
    const draft = this.draft();
    return (
      !!draft &&
      this.store.manager() &&
      this.store.auth.can('schools:manage', {
        kind: 'district',
        customerId: draft.customerId,
      })
    );
  });
  readonly editable = computed(
    () =>
      this.writable() &&
      !this.busy() &&
      !this.pending() &&
      !this.review()?.appliedAt,
  );
  readonly canPreview = computed(() => {
    const draft = this.draft();
    const references = this.store.references();
    return (
      this.editable() &&
      !this.conflict() &&
      this.store.fresh() &&
      references?.customerId === draft?.customerId &&
      schoolPreviewSchema.safeParse({
        ...draft,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        referenceRevision: references?.observation?.revision,
      }).success
    );
  });
  readonly canConfirm = computed(() => {
    const review = this.review();
    const pending = this.pending();
    return (
      this.writable() &&
      !this.busy() &&
      this.confirmed() &&
      !!review &&
      !review.appliedAt &&
      pending?.stage === 'review' &&
      pending.actorVersion ===
        this.store.auth.session()?.identity.permissionVersion &&
      this.store.fresh() &&
      review.referenceRevision ===
        this.store.references()?.observation?.revision &&
      review.customerId === this.store.references()?.customerId &&
      Date.parse(review.expiresAt) > this.store.now()
    );
  });
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly principal = this.store.auth.session()?.identity.id ?? '';
  private readonly storageKey = `cc.school-editor.${this.principal}`;
  private operation = 0;
  private destroyed = false;
  private sessionKey = this.store.sessionKey();

  constructor() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (raw) {
        const saved = savedSchema.parse(JSON.parse(raw));
        this.draft.set(saved.draft);
        this.pending.set(saved.pending);
        if (saved.receipt?.appliedAt) this.review.set(saved.receipt);
        this.message.set(
          saved.pending
            ? 'A school change is still waiting for confirmation. Check its save status before editing.'
            : 'Restored your school draft. Refresh saved data before review.',
        );
        this.conflict.set(!saved.pending && saved.draft.expectedRevision > 0);
      }
    } catch {
      this.storageError.set(
        'This tab cannot restore the school draft. Check saved schools before creating another change.',
      );
    }
    effect(() => {
      const key = this.store.sessionKey();
      if (key === this.sessionKey) return;
      this.sessionKey = key;
      untracked(() => {
        this.operation += 1;
        this.busy.set(false);
        this.confirmed.set(false);
        if (!this.review()?.appliedAt) this.review.set(null);
        const session = this.store.auth.session();
        if (session && session.identity.id !== this.principal) {
          this.draft.set(null);
          this.pending.set(null);
          this.review.set(null);
        } else if (this.pending())
          this.message.set(
            'Access changed. Recover the school review after you recheck access.',
          );
      });
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.operation += 1;
  }

  begin(school?: SchoolDefinition) {
    if (!this.store.manager() || this.draft() || this.busy()) return;
    const customerId =
      school?.customerId ?? this.store.references()?.customerId;
    if (!customerId) return;
    this.draft.set({
      schoolId: school?.id ?? crypto.randomUUID(),
      customerId,
      expectedRevision: school?.revision ?? 0,
      name: school?.name ?? '',
      rules: school
        ? structuredClone(school.rules)
        : { include: [], exclude: [] },
    });
    this.review.set(null);
    this.pending.set(null);
    this.conflict.set(false);
    this.error.set('');
    this.message.set('');
    this.persist();
    this.focus('#school-name');
  }

  editName(name: string) {
    if (!this.editable()) return;
    this.draft.update((draft) => (draft ? { ...draft, name } : draft));
    this.persist();
  }

  addRule(kind: 'include' | 'exclude') {
    const selected = this.selected();
    const draft = this.draft();
    if (!selected || !draft || !this.editable() || !this.store.fresh()) return;
    if (draft.rules[kind].length >= 128) {
      this.error.set(
        'Each rule list permits 128 organizational units. Remove a rule before adding another.',
      );
      return;
    }
    const rules = {
      include: draft.rules.include.filter((rule) => rule.id !== selected.id),
      exclude: draft.rules.exclude.filter((rule) => rule.id !== selected.id),
    };
    rules[kind].push({ id: selected.id, descendants: this.descendants() });
    this.draft.set({ ...draft, rules });
    this.persist();
    this.message.set(
      `${selected.path} now has an ${kind === 'include' ? 'inclusion' : 'exclusion'} rule.`,
    );
  }

  removeRule(kind: 'include' | 'exclude', id: string) {
    const draft = this.draft();
    if (!draft || !this.editable()) return;
    this.draft.set({
      ...draft,
      rules: {
        ...draft.rules,
        [kind]: draft.rules[kind].filter((rule) => rule.id !== id),
      },
    });
    this.persist();
    this.focus('#school-rules-title');
  }

  unitLabel(id: string) {
    const unit = this.store
      .references()
      ?.observation?.units.find((unit) => unit.id === id);
    return unit ? `${unit.path} (${id})` : `Unavailable reference (${id})`;
  }

  returnToDraft() {
    if (this.busy() || this.pending()?.stage === 'confirm') return;
    const receipt = this.review();
    if (receipt?.appliedAt && receipt.revision)
      this.draft.update((draft) =>
        draft ? { ...draft, expectedRevision: receipt.revision! } : draft,
      );
    this.pending.set(null);
    this.review.set(null);
    this.confirmed.set(false);
    this.error.set('');
    this.message.set('Review the draft again before saving.');
    if (this.draft()?.expectedRevision === 0) this.conflict.set(false);
    this.persist();
    this.focus('#school-name');
  }

  close() {
    if (this.busy() || this.pending()?.stage === 'confirm') return;
    this.draft.set(null);
    this.pending.set(null);
    this.review.set(null);
    this.persist();
    this.closed.emit();
  }

  async useLatestRevision() {
    const draft = this.draft();
    if (!draft || !this.editable()) return;
    await this.store.inspect(draft.schoolId);
    const latest = this.store.detail();
    if (
      !this.writable() ||
      this.draft() !== draft ||
      this.store.errors().detail ||
      latest?.id !== draft.schoolId ||
      latest.customerId !== draft.customerId
    )
      return;
    this.draft.set({ ...draft, expectedRevision: latest.revision });
    this.conflict.set(false);
    this.persist();
    this.message.set(
      'Your edits now use the latest saved school. Review the organizational units before saving.',
    );
    this.focus('#school-name');
  }

  private persist() {
    try {
      const draft = this.draft();
      if (draft)
        sessionStorage.setItem(
          this.storageKey,
          JSON.stringify({
            draft,
            pending: this.pending(),
            receipt: this.review()?.appliedAt ? this.review() : null,
          }),
        );
      else sessionStorage.removeItem(this.storageKey);
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until the school save result is confirmed.',
      );
    }
  }

  private focus(selector = '#school-editor-status') {
    const operation = this.operation;
    const session = this.store.sessionKey();
    afterNextRender(
      () => {
        if (
          !this.destroyed &&
          operation === this.operation &&
          session === this.store.sessionKey()
        )
          this.element.nativeElement
            .querySelector<HTMLElement>(selector)
            ?.focus();
      },
      { injector: this.injector },
    );
  }

  private matches(review: SchoolReview, pending: Pending) {
    const input = pending.input;
    return (
      review.id === input.id &&
      review.schoolId === input.schoolId &&
      review.customerId === input.customerId &&
      review.expectedRevision === input.expectedRevision &&
      review.referenceRevision === input.referenceRevision &&
      review.name === input.name &&
      JSON.stringify(review.rules) === JSON.stringify(input.rules) &&
      (review.appliedAt
        ? review.revision === input.expectedRevision + 1
        : review.revision === null)
    );
  }

  private accept(body: unknown, pending: Pending) {
    const review = schoolReviewSchema.parse(body);
    if (!this.matches(review, pending)) throw new Error();
    this.review.set(review);
    this.confirmed.set(false);
    if (review.appliedAt) {
      this.pending.set(null);
      this.message.set(
        'School saved. The confirmation shows its organizational units.',
      );
      this.persist();
      this.saved.emit(review.schoolId);
    } else {
      this.pending.set({
        ...pending,
        stage: pending.stage === 'confirm' ? 'confirm' : 'review',
      });
      this.persist();
      this.message.set(
        pending.stage === 'confirm'
          ? 'The save is not confirmed yet. Retry the confirmation to check again.'
          : 'Check the organizational units and access changes before saving.',
      );
    }
  }

  private async request(kind: 'preview' | 'confirm' | 'recover') {
    const pending = this.pending();
    if (!pending || this.busy() || !this.writable()) return;
    const operation = ++this.operation;
    const key = this.store.sessionKey();
    const current = () =>
      !this.destroyed &&
      operation === this.operation &&
      key === this.store.sessionKey() &&
      this.store.auth.session()?.identity.id === this.principal;
    this.busy.set(true);
    this.error.set('');
    this.message.set(
      kind === 'recover'
        ? 'Checking the school save status.'
        : 'Waiting for the school review result.',
    );
    this.focus();
    try {
      const path =
        kind === 'preview'
          ? '/api/schools/reviews'
          : `/api/schools/reviews/${pending.input.id}${kind === 'confirm' ? '/confirm' : ''}`;
      const response = await this.store.auth.request(
        path,
        kind === 'preview'
          ? pending.input
          : kind === 'confirm'
            ? { confirmed: true }
            : undefined,
      );
      const body: unknown = await response.json();
      if (!current()) return;
      if (response.ok) this.accept(body, pending);
      else if (response.status === 409 && kind !== 'recover') {
        if (kind === 'preview') {
          // A prior preview can survive an interrupted response. Recover its identity before replacing it.
          this.message.set(
            'The saved school and this review no longer match. Check the save status, or refresh your draft and review again.',
          );
        } else {
          this.pending.set(null);
          this.review.set(null);
          this.persist();
        }
        const reason = z.object({ reason: z.string() }).safeParse(body);
        this.conflict.set(
          pending.input.expectedRevision > 0 &&
            (!reason.success || reason.data.reason === 'school-changed'),
        );
        this.error.set(
          this.conflict()
            ? 'Someone changed this school. Use the latest saved school, then review your edits again.'
            : 'Google units or school access changed. Refresh Google units, then review your edits again.',
        );
        await this.store.readReferences();
      } else if (
        kind === 'preview' &&
        [400, 403, 429].includes(response.status)
      ) {
        this.pending.set(null);
        this.persist();
        this.error.set(
          response.status === 429
            ? 'Too many school reviews are pending. Wait for a review to expire, then retry.'
            : 'The server rejected this preview. Check the school name, scope rules, references, and your access.',
        );
      } else if (kind === 'recover' && response.status === 404) {
        this.message.set(
          'No save confirmation is available. Return to your draft only if you have not submitted the save.',
        );
      } else throw new Error();
    } catch {
      if (current())
        this.error.set(
          'We have not received a save confirmation. Check the school save status before editing. Your draft is still here.',
        );
    } finally {
      if (current()) {
        this.busy.set(false);
        this.focus(
          this.review() ? '#school-review-title' : '#school-editor-status',
        );
      }
    }
  }

  preview() {
    if (!this.canPreview()) return;
    const input = schoolPreviewSchema.parse({
      ...this.draft(),
      id: crypto.randomUUID(),
      referenceRevision: this.store.references()?.observation?.revision,
    });
    this.pending.set({
      input,
      stage: 'preview',
      actorVersion: this.store.auth.session()!.identity.permissionVersion,
    });
    this.persist();
    return this.request('preview');
  }

  confirm() {
    if (!this.canConfirm()) return;
    this.pending.update((pending) =>
      pending ? { ...pending, stage: 'confirm' } : pending,
    );
    this.persist();
    return this.request('confirm');
  }

  recover() {
    return this.request('recover');
  }
  retryConfirmation() {
    return this.pending()?.stage === 'confirm'
      ? this.request('confirm')
      : undefined;
  }
}
