import { Injectable, inject } from '@angular/core';
import {
  jobFailureSchema,
  jobStatusSchema,
  userAttributeCategoryJobReceiptSchema,
  userAttributeCategoryPlanSchema,
  type JobFailure,
  type JobStatus,
  type UserAttributeCategoryJobReceipt,
  type UserAttributeCategoryPlan,
  type UserAttributeCategoryPlanRequest,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

/** A refused or unreadable answer. `status` is 0 when the request never answered. */
export interface FlowFailure {
  ok: false;
  status: number;
  reason: string | null;
  /** The answer does not prove that the plan ran no job (a lost or unreadable confirm). */
  uncertain?: boolean;
}

/**
 * The job facts that the dialog shows: the status of the save, its failure, the time it
 * finished, and the stored revision. The revision orders the reads, so a delayed answer
 * never replaces a newer one. The job page owns the full detail, so the dialog reads only
 * these (B section 7). A category job names a category action that the shared job summary
 * does not list yet (K16 and J3 hold the job contract), so the read accepts the raw fields.
 */
export interface CategoryJob {
  displayId: string;
  /** The stored job revision. The contract gives a stored job a revision of at least 1. */
  revision: number;
  status: JobStatus;
  failure: JobFailure | null;
  finishedAt: string | null;
}

export type PlanResult =
  | { ok: true; plan: UserAttributeCategoryPlan }
  | FlowFailure;
export type ConfirmResult =
  | { ok: true; receipt: UserAttributeCategoryJobReceipt }
  | FlowFailure;
export type JobResult = { ok: true; job: CategoryJob } | FlowFailure;

/** The error body that the plan and job routes answer. */
function reasonOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * The five fields of a category job that the dialog shows. A job answer that does not
 * name a display ID, a stored revision, or a known status reads as unreadable, and the
 * dialog says so.
 */
function categoryJobOf(body: unknown): CategoryJob | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const status = jobStatusSchema.safeParse(raw['status']);
  const displayId = raw['displayId'];
  const revision = raw['revision'];
  const failure =
    raw['failure'] === null || raw['failure'] === undefined
      ? null
      : jobFailureSchema.safeParse(raw['failure']);
  const finishedAt =
    typeof raw['finishedAt'] === 'string' ? raw['finishedAt'] : null;
  if (!status.success || typeof displayId !== 'string') return null;
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1
  )
    return null;
  if (failure !== null && !failure.success) return null;
  return {
    displayId,
    revision,
    status: status.data,
    failure: failure === null ? null : failure.data,
    finishedAt,
  };
}

/**
 * The one API surface of the category editor (B section 10): the plan of a save, its
 * confirm, and the job read of the result. The dialog owns the draft; this service owns
 * the wire contract and its parsing.
 */
@Injectable({ providedIn: 'root' })
export class UserCategoryFlow {
  private readonly auth = inject(AuthStore);

  /** Freeze one save. A refused rule answers 422 with its reason. */
  async prepare(
    request: UserAttributeCategoryPlanRequest,
  ): Promise<PlanResult> {
    const result = await this.post(
      '/api/users/attribute-categories/plans',
      request,
    );
    if (!result.ok) return result;
    const plan = userAttributeCategoryPlanSchema.safeParse(result.body);
    if (!plan.success)
      return { ok: false, status: result.status, reason: null };
    return { ok: true, plan: plan.data };
  }

  /** Confirm one plan with its digest and typed phrase. */
  async confirm(
    planId: string,
    digest: string,
    typedPhrase: string | null,
  ): Promise<ConfirmResult> {
    const result = await this.post(
      `/api/users/attribute-categories/plans/${encodeURIComponent(
        planId,
      )}/confirm`,
      {
        digest,
        acknowledged: true,
        ...(typedPhrase === null ? {} : { typedPhrase }),
      },
    );
    if (!result.ok)
      return {
        ...result,
        // A transport failure or a server fault can follow a stored job. Only a
        // typed refusal proves that the save did not start.
        uncertain: result.status === 0 || result.status >= 500,
      };
    const receipt = userAttributeCategoryJobReceiptSchema.safeParse(
      result.body,
    );
    if (!receipt.success)
      // The confirm may have stored the job before its answer became unreadable.
      return {
        ok: false,
        status: result.status,
        reason: null,
        uncertain: true,
      };
    return { ok: true, receipt: receipt.data };
  }

  /** The `GET /api/jobs/{displayId}` read of the running save. */
  async readJob(displayId: string): Promise<JobResult> {
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}`,
      );
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          reason: reasonOf(await response.json().catch(() => null)),
        };
      const job = categoryJobOf(await response.json().catch(() => null));
      if (!job) return { ok: false, status: response.status, reason: null };
      return { ok: true, job };
    } catch {
      return { ok: false, status: 0, reason: null };
    }
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<{ ok: true; status: number; body: unknown } | FlowFailure> {
    try {
      const response = await this.auth.request(path, body);
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          reason: reasonOf(await response.json().catch(() => null)),
        };
      return {
        ok: true,
        status: response.status,
        body: await response.json().catch(() => null),
      };
    } catch {
      return { ok: false, status: 0, reason: null };
    }
  }
}
