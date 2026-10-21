import { Injectable, inject } from '@angular/core';
import type { DeviceActionJobReceipt } from '@campus/application-contracts';
import { z } from 'zod';
import { AuthStore } from '../auth.store';
import { DeviceActionFlow } from './device-action-flow';
import type { DeviceActionFamily } from './device-action-messages';
import {
  confirmationMayExist,
  type FlowProblemKind,
} from './device-update-flow';

/** The storage prefix of one person's uncertain action confirmations in this tab. */
export const ACTION_CONFIRMATION_PREFIX = 'cc.device-action-confirmation.';

/** The confirmation that a sheet submitted, kept until its acceptance is known. */
const submittedActionSchema = z.strictObject({
  family: z.enum(['command', 'status']),
  previewId: z.uuid(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SubmittedActionConfirmation = z.infer<typeof submittedActionSchema>;

/**
 * The answer to a replay of a retained confirmation. `none` means the person holds
 * no record. `expired` means a 410 proved that no job exists. `unresolved` means the
 * answer arrives before the API's existing-receipt lookup, so it cannot prove that
 * the first request created no job.
 */
export type ActionConfirmationReplay =
  | { kind: 'none' }
  | { kind: 'receipt'; receipt: DeviceActionJobReceipt }
  | { kind: 'expired' }
  | {
      kind: 'unresolved';
      submitted: SubmittedActionConfirmation;
      answer: FlowProblemKind;
      expiresAt: string | null;
    }
  | { kind: 'problem'; answer: FlowProblemKind; expiresAt: string | null }
  | { kind: 'uncertain'; submitted: SubmittedActionConfirmation };

/**
 * The uncertain confirmation of the action sheets. A confirmation whose answer was
 * lost keeps its family, submitted preview, and digest in this tab, so a replay
 * sends the identical request and recovers the receipt of a job that the first
 * request created. Every path that opens a sheet or prepares a preview resolves
 * these records first (UI-07, UI-08).
 */
@Injectable({ providedIn: 'root' })
export class DeviceActionConfirmationStore {
  private readonly auth = inject(AuthStore);
  private readonly flow = inject(DeviceActionFlow);

  /** Keep the submitted confirmation until an answer settles its acceptance. */
  retain(submitted: SubmittedActionConfirmation): void {
    const key = this.key(submitted.family, submitted.previewId);
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(submitted));
    } catch {
      // The sheet still holds the submission in memory.
    }
  }

  release(family: DeviceActionFamily, previewId: string): void {
    const key = this.key(family, previewId);
    if (!key) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      // A blocked storage area holds nothing to remove.
    }
  }

  retained(
    family: DeviceActionFamily,
    previewId: string,
  ): SubmittedActionConfirmation | null {
    const key = this.key(family, previewId);
    return key ? this.read(key, family) : null;
  }

  /** Every uncertain confirmation of this person and family in this tab. */
  pending(family: DeviceActionFamily): SubmittedActionConfirmation[] {
    const prefix = this.familyPrefix(family);
    if (!prefix) return [];
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
    return keys
      .map((key) => this.read(key, family))
      .filter(
        (record): record is SubmittedActionConfirmation => record !== null,
      );
  }

  /**
   * Replay every uncertain confirmation of this person and family. A 410 proves
   * that no job exists, so its record clears and the caller proceeds. Any other
   * answer ends the replay: a receipt, an unresolved answer that may hide a job, the
   * named problem, or the uncertain state.
   */
  async resolvePending(
    family: DeviceActionFamily,
  ): Promise<ActionConfirmationReplay> {
    let last: ActionConfirmationReplay = { kind: 'none' };
    for (const submitted of this.pending(family)) {
      const answer = await this.replay(submitted);
      if (answer.kind !== 'expired') return answer;
      last = answer;
    }
    return last;
  }

  /** Replay one retained confirmation and settle its record. */
  private async replay(
    submitted: SubmittedActionConfirmation,
  ): Promise<ActionConfirmationReplay> {
    const result = await this.flow.confirm(
      submitted.family,
      submitted.previewId,
      submitted.manifestDigest,
    );
    if (result.ok) {
      this.release(submitted.family, submitted.previewId);
      return { kind: 'receipt', receipt: result.value };
    }
    if (result.answer === 'preview-expired') {
      this.release(submitted.family, submitted.previewId);
      return { kind: 'expired' };
    }
    if (result.answer === 'confirm-uncertain') {
      return { kind: 'uncertain', submitted };
    }
    // Some named answers arrive before the API checks for an existing receipt. They
    // cannot prove that the first request created no job, so the identity stays.
    if (confirmationMayExist(result.answer)) {
      return {
        kind: 'unresolved',
        submitted,
        answer: result.answer,
        expiresAt: result.expiresAt,
      };
    }
    // A definitive named answer settles the record. The design names every 4xx it
    // returns after the receipt lookup, so the sheet shows that answer.
    this.release(submitted.family, submitted.previewId);
    return {
      kind: 'problem',
      answer: result.answer,
      expiresAt: result.expiresAt,
    };
  }

  /** One record for each person, family, and preview. */
  private key(family: DeviceActionFamily, previewId: string): string | null {
    const prefix = this.familyPrefix(family);
    return prefix ? `${prefix}${previewId}` : null;
  }

  private familyPrefix(family: DeviceActionFamily): string | null {
    const principal = this.auth.session()?.identity.id;
    return principal
      ? `${ACTION_CONFIRMATION_PREFIX}${principal}.${family}.`
      : null;
  }

  /** A malformed record cannot drive a replay, so it clears. */
  private read(
    key: string,
    family: DeviceActionFamily,
  ): SubmittedActionConfirmation | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = submittedActionSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.family === family) return parsed.data;
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
