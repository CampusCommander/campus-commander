import { Injectable } from '@angular/core';
import type { UserAttributePreview } from '@campus/application-contracts';

/**
 * One confirmation whose acceptance is unknown. The answer may have created the job, so
 * the preview, the digest, and the submitted names stay together until a receipt answers
 * the same preview (R2-B).
 */
export interface PendingAttributeConfirmation {
  /** The user whose card opened the save. */
  userId: string;
  /** The preview whose confirmation the card replays. */
  preview: UserAttributePreview;
  /** The attribute names of the confirmation in flight, for the saved line. */
  attributeNames: string[];
  /** The sentence of the latest uncertain answer. */
  message: string;
}

/**
 * The uncertain confirmation of the card form. The editor dies on Cancel, on Next user,
 * and on Back, so this root store keeps the preview identity until a receipt resolves it
 * (R2-B). Reopening the form of the same user continues the one confirmation instead of
 * preparing another preview.
 */
@Injectable({ providedIn: 'root' })
export class UserAttributeConfirmationStore {
  private readonly entries = new Map<string, PendingAttributeConfirmation>();

  /** The unresolved confirmation of one user, or null. */
  pending(userId: string): PendingAttributeConfirmation | null {
    return this.entries.get(userId) ?? null;
  }

  /** Whether one preview still waits for a conclusive answer. */
  isPending(previewId: string): boolean {
    for (const entry of this.entries.values())
      if (entry.preview.previewId === previewId) return true;
    return false;
  }

  /** Keep the original preview, digest, and submitted context. */
  remember(entry: PendingAttributeConfirmation): void {
    this.entries.set(entry.userId, entry);
  }

  /** A receipt answered the confirmation, so a later save may prepare a new preview. */
  resolve(previewId: string): void {
    for (const [userId, entry] of this.entries)
      if (entry.preview.previewId === previewId) this.entries.delete(userId);
  }
}
