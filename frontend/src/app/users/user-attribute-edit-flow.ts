import { Injectable, inject } from '@angular/core';
import {
  GOOGLE_HEALTH_RECOVERY,
  googleFailureSchema,
  jobDetailSchema,
  userAttributeJobReceiptSchema,
  userAttributePreviewSchema,
  userAttributeTargetsPageSchema,
  type JobDetail,
  type UserAttributeEdit,
  type UserAttributeJobReceipt,
  type UserAttributePreview,
  type UserAttributeTarget,
  type UserAttributeTargetsPage,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  ATTRIBUTE_CATEGORY_CHANGED_TEXT,
  ATTRIBUTE_CONNECTION_TEXT,
  ATTRIBUTE_FAILED_TEXT,
  ATTRIBUTE_FORBIDDEN_TEXT,
  ATTRIBUTE_NO_CHANGE_TEXT,
  ATTRIBUTE_OFFLINE_TEXT,
  ATTRIBUTE_PERMISSION_CHANGED_TEXT,
  ATTRIBUTE_PREVIEW_CHANGED_TEXT,
  ATTRIBUTE_PREVIEW_CONFLICT_TEXT,
  ATTRIBUTE_PREVIEW_EXPIRED_TEXT,
  ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT,
  ATTRIBUTE_READ_FAILED_TEXT,
  ATTRIBUTE_REFUSED_TEXT,
  ATTRIBUTE_SIZE_LIMIT_TEXT,
  ATTRIBUTE_UNSETTLED_TEXT,
} from './user-attribute-edit-messages';

/** One flow answer: the value, or the sentence that the form shows. */
export type AttributeFlowAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** The five job statuses that need no more reads (job contracts, section 1.2). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
  'cancelled',
]);

/** The Google failure sentence of a 503 `user-read-failed` answer, or null. */
function readFailureText(raw: unknown): string | null {
  const failure = googleFailureSchema.safeParse(raw);
  if (!failure.success) return null;
  const entry = GOOGLE_HEALTH_RECOVERY[failure.data];
  return entry ? `${entry.label}. ${entry.recovery}` : null;
}

/** The sentence of one refused answer. The API message wins when it holds one. */
export function attributeAnswerMessage(status: number, body: unknown): string {
  const answer =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : {};
  const reason =
    typeof answer['reason'] === 'string'
      ? answer['reason']
      : typeof answer['code'] === 'string'
        ? answer['code']
        : '';
  const message =
    typeof answer['message'] === 'string' && answer['message'].trim().length
      ? answer['message']
      : null;
  // The card names these exact words for a body above the 64 MiB cap.
  if (status === 413) return ATTRIBUTE_SIZE_LIMIT_TEXT;
  if (status === 409) {
    if (reason === 'category-changed') return ATTRIBUTE_CATEGORY_CHANGED_TEXT;
    if (reason === 'preview-conflict') return ATTRIBUTE_PREVIEW_CONFLICT_TEXT;
    if (reason === 'preview-expired') return ATTRIBUTE_PREVIEW_EXPIRED_TEXT;
    if (reason === 'preview-changed') return ATTRIBUTE_PREVIEW_CHANGED_TEXT;
    if (reason === 'connection-required' || reason === 'connection-changed')
      return ATTRIBUTE_CONNECTION_TEXT;
    if (reason === 'permission-changed')
      return ATTRIBUTE_PERMISSION_CHANGED_TEXT;
  }
  if (status === 422) {
    if (reason === 'nothing-to-update') return ATTRIBUTE_NO_CHANGE_TEXT;
    return message ?? ATTRIBUTE_REFUSED_TEXT;
  }
  // The preview route names an expired preview with 410 Gone (B section 13).
  if (status === 410) return ATTRIBUTE_PREVIEW_EXPIRED_TEXT;
  if (status === 409 && reason === 'preview-changed')
    return ATTRIBUTE_PREVIEW_CHANGED_TEXT;
  if (status === 503 && reason === 'user-read-failed')
    return readFailureText(answer['failure']) ?? ATTRIBUTE_READ_FAILED_TEXT;
  if (status === 403) return ATTRIBUTE_FORBIDDEN_TEXT;
  if (status === 401) return ATTRIBUTE_PERMISSION_CHANGED_TEXT;
  if (status === 404) return ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT;
  return message ?? ATTRIBUTE_REFUSED_TEXT;
}

/**
 * The preview, confirm, and job reads of the details card form (B section 10, design K25).
 * The browser sends the edits of the open save and reads one preview. It never loads
 * another user.
 */
@Injectable({ providedIn: 'root' })
export class UserAttributeEditFlow {
  private readonly auth = inject(AuthStore);

  /** `POST /api/users/attribute-previews` with one edit list. */
  async prepare(
    edits: readonly UserAttributeEdit[],
  ): Promise<AttributeFlowAnswer<UserAttributePreview>> {
    return this.send(
      '/api/users/attribute-previews',
      { edits: [...edits] },
      (body) => userAttributePreviewSchema.safeParse(body),
    );
  }

  /** One page of the preview rows, in the shape of the route. */
  async readTargetsPage(
    previewId: string,
    cursor: string | null,
  ): Promise<AttributeFlowAnswer<UserAttributeTargetsPage>> {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await this.auth.request(
        `/api/users/attribute-previews/${encodeURIComponent(previewId)}/targets?${query}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        return {
          ok: false,
          message: attributeAnswerMessage(response.status, body),
        };
      const page = userAttributeTargetsPageSchema.safeParse(body);
      return page.success
        ? { ok: true, value: page.data }
        : { ok: false, message: ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT };
    } catch {
      return { ok: false, message: ATTRIBUTE_OFFLINE_TEXT };
    }
  }

  /** Every frozen row of one preview through the route cursor. */
  async readTargets(
    previewId: string,
  ): Promise<AttributeFlowAnswer<UserAttributeTarget[]>> {
    const targets: UserAttributeTarget[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const answer = await this.readTargetsPage(previewId, cursor);
      if (!answer.ok) return answer;
      targets.push(...answer.value.targets);
      cursor = answer.value.nextCursor;
      if (!cursor) return { ok: true, value: targets };
    }
    return { ok: true, value: targets };
  }

  /** `POST .../{previewId}/confirm` with the digest and the acknowledgment. */
  async confirm(
    previewId: string,
    manifestDigest: string,
  ): Promise<AttributeFlowAnswer<UserAttributeJobReceipt>> {
    return this.send(
      `/api/users/attribute-previews/${encodeURIComponent(previewId)}/confirm`,
      { manifestDigest, acknowledged: true },
      (body) => userAttributeJobReceiptSchema.safeParse(body),
    );
  }

  /** `GET /api/jobs/{displayId}` for the value job of one receipt. */
  async readJob(displayId: string): Promise<AttributeFlowAnswer<JobDetail>> {
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        return {
          ok: false,
          message: attributeAnswerMessage(response.status, body),
        };
      const job = jobDetailSchema.safeParse(body);
      return job.success
        ? { ok: true, value: job.data }
        : { ok: false, message: ATTRIBUTE_FAILED_TEXT };
    } catch {
      return { ok: false, message: ATTRIBUTE_OFFLINE_TEXT };
    }
  }

  /**
   * Poll the job of one receipt until it settles. A job that leaves no readable answer
   * stays unsettled; the caller keeps the receipt and its job link.
   */
  async waitForJob(
    displayId: string,
    attempts = 120,
    delayMs = 1000,
  ): Promise<AttributeFlowAnswer<JobDetail>> {
    let answer = await this.readJob(displayId);
    for (let attempt = 1; attempt < attempts; attempt++) {
      if (!answer.ok || TERMINAL_STATUSES.has(answer.value.status)) {
        return answer;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      answer = await this.readJob(displayId);
    }
    // A job that stays open past the last read leaves the receipt and its link in place.
    return answer.ok
      ? { ok: false, message: ATTRIBUTE_UNSETTLED_TEXT }
      : answer;
  }

  private async send<T>(
    path: string,
    request: unknown,
    parse: (body: unknown) => { success: true; data: T } | { success: false },
  ): Promise<AttributeFlowAnswer<T>> {
    try {
      const response = await this.auth.request(path, request);
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        return {
          ok: false,
          message: attributeAnswerMessage(response.status, body),
        };
      const parsed = parse(body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT };
    } catch {
      return { ok: false, message: ATTRIBUTE_OFFLINE_TEXT };
    }
  }
}
