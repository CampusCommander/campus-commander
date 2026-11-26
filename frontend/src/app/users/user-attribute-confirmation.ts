import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  userAttributeEditSchema,
  userAttributePreviewSchema,
  type UserAttributeEdit,
  type UserAttributePreview,
} from '@campus/application-contracts';
import { z } from 'zod';
import { AuthStore } from '../auth.store';

/** The storage prefix of one person's retained value confirmations in this tab. */
export const USER_ATTRIBUTE_CONFIRMATION_PREFIX =
  'cc.user-attribute-confirmation.';

/**
 * The point that one confirmation reached at the level that outlives the editor.
 * `confirming` covers the answer that is still in flight, so a reopened form waits for
 * it instead of preparing a second preview (R3-A). `accepted` holds the receipt while
 * its job still needs observation (R3-B). `refused` is a definite answer that released
 * the preview identity, and it keeps the sentence for the next form.
 */
export type AttributeConfirmationPhase =
  | 'confirming'
  | 'uncertain'
  | 'accepted'
  | 'refused';

/**
 * One confirmation of the card form. The editor dies on Cancel, on Next user, and on
 * Back, so this root store keeps the preview identity, the submitted names, and the
 * phase until a receipt settles the save (R2-B, R3-A, R3-B).
 */
export interface PendingAttributeConfirmation {
  /** The user whose card opened the save. */
  userId: string;
  /** The preview whose confirmation the card replays. */
  preview: UserAttributePreview;
  /** The attribute names of the confirmation, for the saved line. */
  attributeNames: string[];
  /**
   * The frozen edit list that the preview was prepared from (K26). Acceptance and
   * recovery compare against this list, never against a later draft (R2-B).
   */
  edits: UserAttributeEdit[];
  /** The sentence of the latest answer. */
  message: string;
  phase: AttributeConfirmationPhase;
  /** The accepted receipt whose job still needs observation. */
  displayId: string | null;
}

/**
 * The shape of one retained confirmation in this tab. A record that does not match
 * cannot drive a replay, so a read clears it. The contract schemas check the preview
 * and the frozen edits. `refused` is never stored, because a definite answer releases
 * the preview identity.
 */
const pendingAttributeConfirmationSchema = z.strictObject({
  /** The scope key of the confirmation: a user ID, or the grid or selection key. */
  userId: z.string().min(1).max(1024),
  preview: userAttributePreviewSchema,
  attributeNames: z.array(z.string().max(4096)).max(2500),
  edits: z.array(userAttributeEditSchema).max(2500),
  message: z.string().max(8192),
  phase: z.enum(['confirming', 'uncertain', 'accepted', 'refused']),
  displayId: z.string().min(1).max(64).nullable(),
});

/**
 * The confirmation of the Custom attributes card form. The store records the frozen
 * identity before the first send, keeps it through an unknown answer, and hands the
 * accepted receipt to the next owner when the editor dies (R3-A, R3-B). Reopening the
 * form of the same user continues the one save instead of preparing another preview.
 * A confirmation with no known answer and an accepted receipt stay in this tab, so a
 * page reload replays the same preview and digest before any new preview (K25 to K27).
 */
@Injectable({ providedIn: 'root' })
export class UserAttributeConfirmationStore {
  private readonly auth = inject(AuthStore);
  private readonly entries = signal<
    ReadonlyMap<string, PendingAttributeConfirmation>
  >(new Map());
  /**
   * The immutable edit lists by preview ID (K26). The page retains one while it prepares
   * a preview, and the first confirmation entry takes it over. The map is a handoff
   * buffer, not a cache: a preview that no confirmation owns is released (R3-B).
   */
  private readonly editLists = new Map<string, UserAttributeEdit[]>();
  /**
   * The scopes whose entry came back from this tab's storage. Only a restored entry
   * needs a replay on open, because no request of the current page is in flight.
   */
  private readonly restoredScopes = new Set<string>();
  /** The person whose entries this store holds. */
  private principal: string | null = this.auth.session()?.identity.id ?? null;

  constructor() {
    this.restore();
    // Another person signs in in this tab: the earlier person's entries never survive.
    effect(() => {
      const principal = this.auth.session()?.identity.id ?? null;
      if (principal === this.principal) return;
      untracked(() => this.restore());
    });
  }

  /** The retained confirmation of one user, or null. */
  pending(userId: string): PendingAttributeConfirmation | null {
    return this.entries().get(userId) ?? null;
  }

  /** Whether one scope's confirmation came back from this tab's storage. */
  restored(userId: string): boolean {
    return this.restoredScopes.has(userId);
  }

  /**
   * Keep the frozen edit list of one prepared preview (K26). A later draft never changes
   * it, so acceptance removes only the entries that this preview submitted (R2-B).
   */
  retainEdits(previewId: string, edits: readonly UserAttributeEdit[]): void {
    this.editLists.set(
      previewId,
      edits.map((edit) => ({ ...edit, values: [...edit.values] })),
    );
  }

  /** The retained edit list of one preview, or an empty list. */
  editsFor(previewId: string): readonly UserAttributeEdit[] {
    return this.editLists.get(previewId) ?? [];
  }

  /**
   * Release the retained list of one preview that no confirmation owns (R3-B). A
   * confirmation entry carries its own frozen copy, so this never truncates a save.
   */
  discardEdits(previewId: string): void {
    this.editLists.delete(previewId);
  }

  /** Whether one preview still owns an answer that a new save must not replace. */
  isPending(previewId: string): boolean {
    for (const entry of this.entries().values())
      if (entry.preview.previewId === previewId && entry.phase !== 'refused')
        return true;
    return false;
  }

  /** Record the frozen identity before its first send (R3-A). */
  begin(
    userId: string,
    preview: UserAttributePreview,
    attributeNames: readonly string[],
  ): void {
    this.write({
      userId,
      preview,
      attributeNames: [...attributeNames],
      edits: this.frozenEdits(userId, preview.previewId),
      message: '',
      phase: 'confirming',
      displayId: null,
    });
    // The entry now owns the frozen list, so the handoff copy has no other reader (R3-B).
    this.editLists.delete(preview.previewId);
  }

  /** Keep the same preview, digest, and names after an answer that may have created the job. */
  uncertain(
    userId: string,
    preview: UserAttributePreview,
    attributeNames: readonly string[],
    message: string,
  ): void {
    this.write({
      userId,
      preview,
      attributeNames: [...attributeNames],
      edits: this.frozenEdits(userId, preview.previewId),
      message,
      phase: 'uncertain',
      displayId: null,
    });
  }

  /** Hand the accepted receipt to the owner that survives this editor (R3-B). */
  accept(
    userId: string,
    preview: UserAttributePreview,
    attributeNames: readonly string[],
    displayId: string,
  ): void {
    this.write({
      userId,
      preview,
      attributeNames: [...attributeNames],
      edits: this.frozenEdits(userId, preview.previewId),
      message: '',
      phase: 'accepted',
      displayId,
    });
  }

  /** A definite refusal releases the identity, and its sentence waits for the next form. */
  refuse(
    userId: string,
    preview: UserAttributePreview,
    attributeNames: readonly string[],
    message: string,
  ): void {
    this.write({
      userId,
      preview,
      attributeNames: [...attributeNames],
      edits: this.frozenEdits(userId, preview.previewId),
      message,
      phase: 'refused',
      displayId: null,
    });
  }

  /** A receipt answered the confirmation, so a later save may prepare a new preview. */
  resolve(previewId: string): void {
    this.editLists.delete(previewId);
    const entries = new Map(this.entries());
    let changed = false;
    for (const [userId, entry] of entries) {
      if (entry.preview.previewId !== previewId) continue;
      entries.delete(userId);
      this.restoredScopes.delete(userId);
      changed = true;
    }
    if (changed) this.entries.set(entries);
    this.removeStored((entry) => entry.preview.previewId === previewId);
  }

  /**
   * The accepted receipt settled, so its preview may create a new save. A receipt that
   * outlived the editor stays here until its job answers, through any polling handoff
   * (R4-A). A different phase keeps its own rule.
   */
  resolveReceipt(displayId: string): void {
    const entries = new Map(this.entries());
    let changed = false;
    for (const [userId, entry] of entries) {
      if (entry.displayId !== displayId || entry.phase !== 'accepted') continue;
      entries.delete(userId);
      this.editLists.delete(entry.preview.previewId);
      this.restoredScopes.delete(userId);
      changed = true;
    }
    if (changed) this.entries.set(entries);
    this.removeStored(
      (entry) => entry.phase === 'accepted' && entry.displayId === displayId,
    );
  }

  /** Load the retained confirmations of this person after a page reload. */
  restore(): void {
    const principal = this.auth.session()?.identity.id ?? null;
    if (principal !== this.principal) {
      // Another person owns this tab now. No entry of the earlier person survives.
      this.entries.set(new Map());
      this.editLists.clear();
      this.restoredScopes.clear();
      this.principal = principal;
    }
    if (!principal) return;
    const entries = new Map(this.entries());
    let changed = false;
    for (const { scope, entry } of this.stored(principal)) {
      if (entries.has(scope)) continue;
      entries.set(scope, entry);
      this.restoredScopes.add(scope);
      changed = true;
    }
    if (changed) this.entries.set(entries);
  }

  /**
   * The frozen bindings of one write. The first write takes the retained handoff list, and
   * a later write of the same confirmation keeps the list in its own entry (R3-B). That
   * keeps the identity through begin, uncertain, accept, and refuse.
   */
  private frozenEdits(userId: string, previewId: string): UserAttributeEdit[] {
    const existing = this.entries().get(userId);
    const list =
      existing?.preview.previewId === previewId
        ? existing.edits
        : this.editsFor(previewId);
    return list.map((edit) => ({ ...edit, values: [...edit.values] }));
  }

  private write(entry: PendingAttributeConfirmation): void {
    const entries = new Map(this.entries());
    entries.set(entry.userId, entry);
    this.entries.set(entries);
    this.restoredScopes.delete(entry.userId);
    // A definite refusal removes the record. The entry stays in memory until its next
    // owner shows the sentence, as it did before the tab kept any record.
    if (entry.phase === 'refused')
      this.removeStored((candidate) => candidate.userId === entry.userId);
    else this.retain(entry);
  }

  /** Keep one confirmation under this person's prefix in this tab. */
  private retain(entry: PendingAttributeConfirmation): void {
    const key = this.key(entry.userId);
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(entry));
    } catch {
      // The page still holds the confirmation in memory.
    }
  }

  /** Remove the stored record of one scope, when it holds one. */
  private removeStored(
    match: (entry: PendingAttributeConfirmation) => boolean,
  ): void {
    if (!this.principal) return;
    for (const { key, entry } of this.stored(this.principal)) {
      if (!match(entry)) continue;
      try {
        sessionStorage.removeItem(key);
      } catch {
        // A blocked storage area holds nothing to remove.
      }
    }
  }

  /** One record for each person and scope. */
  private key(scope: string): string | null {
    return this.principal
      ? `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${this.principal}.${scope}`
      : null;
  }

  /** Every readable record under this person's prefix. A malformed one clears. */
  private stored(
    principal: string,
  ): { key: string; scope: string; entry: PendingAttributeConfirmation }[] {
    const prefix = `${USER_ATTRIBUTE_CONFIRMATION_PREFIX}${principal}.`;
    const keys: string[] = [];
    try {
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
    } catch {
      // A blocked storage area holds no record.
      return [];
    }
    const records: {
      key: string;
      scope: string;
      entry: PendingAttributeConfirmation;
    }[] = [];
    for (const key of keys) {
      const scope = key.slice(prefix.length);
      const entry = this.read(key, scope);
      if (entry) records.push({ key, scope, entry });
    }
    return records;
  }

  /**
   * A malformed record cannot drive a replay, so it clears. A record of another scope
   * in this person's prefix and a refusal never load either.
   */
  private read(
    key: string,
    scope: string,
  ): PendingAttributeConfirmation | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = pendingAttributeConfirmationSchema.safeParse(
        JSON.parse(raw),
      );
      if (
        parsed.success &&
        parsed.data.userId === scope &&
        parsed.data.phase !== 'refused'
      )
        return parsed.data;
      sessionStorage.removeItem(key);
      return null;
    } catch {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // A blocked storage area holds nothing to remove.
      }
      return null;
    }
  }
}
