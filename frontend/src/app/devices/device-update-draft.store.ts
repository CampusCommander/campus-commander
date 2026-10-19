import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { z } from 'zod';
import type { DeviceUpdateMode } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

const savedDraftSchema = z.strictObject({
  value: z.string().max(4096),
  mode: z.enum(['replace', 'clear']),
});

/**
 * The unsubmitted annotated-location draft. It lives outside the grid, so filtering,
 * scrolling, and row updates never touch it (DRAFT-01). Each browser tab restores the
 * draft of the signed-in person after a refresh.
 */
@Injectable({ providedIn: 'root' })
export class DeviceUpdateDraftStore {
  private readonly auth = inject(AuthStore);
  readonly value = signal('');
  readonly mode = signal<DeviceUpdateMode>('replace');
  /** The annotated-location field holds an unsubmitted change. */
  readonly changed = computed(
    () => this.mode() === 'clear' || this.value().length > 0,
  );
  readonly storageError = signal('');
  private principal = this.auth.session()?.identity.id ?? null;

  constructor() {
    this.restore();
    effect(() => {
      const id = this.auth.session()?.identity.id ?? null;
      if (id === this.principal) return;
      untracked(() => this.restore());
    });
  }

  setValue(value: string): void {
    this.value.set(value);
    this.persist();
  }

  setMode(mode: DeviceUpdateMode): void {
    this.mode.set(mode);
    this.persist();
  }

  /** Discards the draft. The selection and the grid stay as they are. */
  reset(): void {
    this.value.set('');
    this.mode.set('replace');
    this.persist();
  }

  /** Restore the draft of the signed-in person. Another person starts clean. */
  restore(): void {
    const id = this.auth.session()?.identity.id ?? null;
    this.principal = id;
    this.value.set('');
    this.mode.set('replace');
    if (!id) return;
    try {
      const raw = sessionStorage.getItem(this.storageKey(id));
      if (!raw) {
        this.storageError.set('');
        return;
      }
      const saved = savedDraftSchema.parse(JSON.parse(raw));
      this.value.set(saved.value);
      this.mode.set(saved.mode);
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'This tab cannot restore the device update draft. Check the annotated location before saving.',
      );
    }
  }

  private storageKey(principal: string): string {
    return `cc.device-update-draft.${principal}`;
  }

  private persist(): void {
    const id = this.principal ?? this.auth.session()?.identity.id ?? null;
    if (!id) return;
    const value = this.value();
    const mode = this.mode();
    try {
      if (value === '' && mode === 'replace')
        sessionStorage.removeItem(this.storageKey(id));
      else
        sessionStorage.setItem(
          this.storageKey(id),
          JSON.stringify(savedDraftSchema.parse({ value, mode })),
        );
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until you prepare the preview.',
      );
    }
  }
}
