import { Injectable, inject } from '@angular/core';
import type {
  DeviceUpdateJobReceipt,
  DeviceUpdatePreview,
} from '@campus/application-contracts';
import { z } from 'zod';
import { AuthStore } from '../auth.store';
import { DeviceUpdateFlow, type FlowProblemKind } from './device-update-flow';

/** The storage prefix of one person's uncertain confirmations in this tab. */
export const CONFIRMATION_PREFIX = 'cc.device-update-confirmation.';

/** The confirmation that a page submitted, kept until its acceptance is known. */
const submittedConfirmationSchema = z.strictObject({
  previewId: z.uuid(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SubmittedConfirmation = z.infer<typeof submittedConfirmationSchema>;

/**
 * The answer to a replay of a retained confirmation. `none` means the person holds
 * no record. `expired` means a 410 proved that no job exists.
 */
export type ConfirmationReplay =
  | { kind: 'none' }
  | { kind: 'receipt'; receipt: DeviceUpdateJobReceipt }
  | { kind: 'expired' }
  | { kind: 'problem'; answer: FlowProblemKind; expiresAt: string | null }
  | { kind: 'uncertain'; submitted: SubmittedConfirmation };

/** The answer to a request that creates a preview after the replay. */
export type PreviewPreparation =
  | { kind: 'preview'; preview: DeviceUpdatePreview }
  | { kind: 'receipt'; receipt: DeviceUpdateJobReceipt }
  | { kind: 'problem'; answer: FlowProblemKind; expiresAt: string | null }
  | { kind: 'uncertain'; submitted: SubmittedConfirmation };

/**
 * The uncertain confirmation of design 2.4. A confirmation whose answer was lost
 * keeps its submitted preview and digest in this tab, so a replay sends the
 * identical request and recovers the receipt of a job that the first request
 * created. Every path that shows an expired preview or creates a preview resolves
 * these records first (UI-07, UI-08).
 */
@Injectable({ providedIn: 'root' })
export class DeviceUpdateConfirmationStore {
  private readonly auth = inject(AuthStore);
  private readonly flow = inject(DeviceUpdateFlow);

  /** Keep the submitted confirmation until an answer settles its acceptance. */
  retain(submitted: SubmittedConfirmation): void {
    const key = this.key(submitted.previewId);
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(submitted));
    } catch {
      // The page still holds the submission in memory.
    }
  }

  release(previewId: string): void {
    const key = this.key(previewId);
    if (!key) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      // A blocked storage area holds nothing to remove.
    }
  }

  retained(previewId: string): SubmittedConfirmation | null {
    const key = this.key(previewId);
    return key ? this.read(key) : null;
  }

  /** Every uncertain confirmation of this person in this tab. */
  pending(): SubmittedConfirmation[] {
    const prefix = this.prefix();
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
      .map((key) => this.read(key))
      .filter((record): record is SubmittedConfirmation => record !== null);
  }

  /**
   * Replay every uncertain confirmation of this person. A 410 proves that no job
   * exists, so its record clears and the caller proceeds. Any other answer ends the
   * replay: a receipt, the named problem, or the uncertain state.
   */
  async resolvePending(): Promise<ConfirmationReplay> {
    let last: ConfirmationReplay = { kind: 'none' };
    for (const submitted of this.pending()) {
      const answer = await this.replay(submitted);
      if (answer.kind !== 'expired') return answer;
      last = answer;
    }
    return last;
  }

  /**
   * Create a preview from the draft, but only after every uncertain confirmation
   * has an answer. A retained record may hold the receipt of a job that already
   * exists, so a replacement preview must wait for the replay.
   */
  async preparePreview(): Promise<PreviewPreparation> {
    const replay = await this.resolvePending();
    if (replay.kind === 'receipt') return replay;
    if (replay.kind === 'problem') return replay;
    if (replay.kind === 'uncertain') return replay;
    const prepared = await this.flow.prepareFromDraft();
    return prepared.ok
      ? { kind: 'preview', preview: prepared.value }
      : {
          kind: 'problem',
          answer: prepared.answer,
          expiresAt: prepared.expiresAt,
        };
  }

  private async replay(
    submitted: SubmittedConfirmation,
  ): Promise<ConfirmationReplay> {
    const result = await this.flow.confirm(
      submitted.previewId,
      submitted.manifestDigest,
    );
    if (result.ok) {
      this.release(submitted.previewId);
      return { kind: 'receipt', receipt: result.value };
    }
    if (result.answer === 'preview-expired') {
      this.release(submitted.previewId);
      return { kind: 'expired' };
    }
    if (result.answer === 'confirm-uncertain') {
      return { kind: 'uncertain', submitted };
    }
    // A named answer is definitive. The design names every 4xx it returns, so the
    // record clears and its Scope item 5 message tells the operator what happened.
    this.release(submitted.previewId);
    return {
      kind: 'problem',
      answer: result.answer,
      expiresAt: result.expiresAt,
    };
  }

  /** One record for each person and preview. */
  private key(previewId: string): string | null {
    const prefix = this.prefix();
    return prefix ? `${prefix}${previewId}` : null;
  }

  private prefix(): string | null {
    const principal = this.auth.session()?.identity.id;
    return principal ? `${CONFIRMATION_PREFIX}${principal}.` : null;
  }

  /** A malformed record cannot drive a replay, so it clears. */
  private read(key: string): SubmittedConfirmation | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = submittedConfirmationSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      sessionStorage.removeItem(key);
      return null;
    } catch {
      return null;
    }
  }
}
