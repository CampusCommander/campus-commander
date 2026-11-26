import { Injectable, inject } from '@angular/core';
import {
  jobAttributeRowsPageSchema,
  userAttributePreviewSchema,
  userAttributeTargetsPageSchema,
  type JobAttributeRowView,
  type JobAttributeRowsPage,
  type UserAttributeChange,
  type UserAttributeDisposition,
  type UserAttributePreview,
  type UserAttributeTargetsPage,
  type UserSelectionKey,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  attributeAnswerMessage,
  type AttributeFlowAnswer,
} from './user-attribute-edit-flow';
import {
  ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT,
  ATTRIBUTE_REFUSED_TEXT,
} from './user-attribute-edit-messages';
import { BULK_ROWS_UNAVAILABLE_TEXT } from './user-attribute-bulk-messages';

/** The rows of one review or results page (composition 11: ten rows a page). */
export const BULK_PAGE_SIZE = 10;

/**
 * The preview, row, and result reads of the Users Bulk Actions dialog (cards K23, K24,
 * and J4). The selection request carries the grid key and the changes, never user IDs.
 * Each row read asks for one page at the cursor that the server answered.
 */
@Injectable({ providedIn: 'root' })
export class UserAttributeBulkFlow {
  private readonly auth = inject(AuthStore);

  /** `POST /api/users/attribute-previews` with the selection key and one change. */
  async prepare(
    selection: UserSelectionKey,
    changes: readonly UserAttributeChange[],
  ): Promise<AttributeFlowAnswer<UserAttributePreview>> {
    return this.send(
      '/api/users/attribute-previews',
      {
        gridId: selection.gridId,
        tabId: selection.tabId,
        changes: changes.map((change) => ({
          schemaName: change.schemaName,
          fieldName: change.fieldName,
          mode: change.mode,
          values: [...change.values],
        })),
      },
      (body) => userAttributePreviewSchema.safeParse(body),
    );
  }

  /** One page of the frozen preview rows, filtered by their disposition. */
  async readTargetsPage(
    previewId: string,
    disposition: UserAttributeDisposition,
    cursor: string | null,
  ): Promise<AttributeFlowAnswer<UserAttributeTargetsPage>> {
    const query = new URLSearchParams({
      disposition,
      limit: String(BULK_PAGE_SIZE),
    });
    if (cursor) query.set('cursor', cursor);
    return this.read(
      `/api/users/attribute-previews/${encodeURIComponent(previewId)}/targets?${query}`,
      (body) => userAttributeTargetsPageSchema.safeParse(body),
      ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT,
    );
  }

  /** One page of the value job rows, in the All or Failed view. */
  async readRowsPage(
    displayId: string,
    view: JobAttributeRowView,
    cursor: string | null,
  ): Promise<AttributeFlowAnswer<JobAttributeRowsPage>> {
    const query = new URLSearchParams({ view, limit: String(BULK_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    return this.read(
      `/api/jobs/${encodeURIComponent(displayId)}/attribute-rows?${query}`,
      (body) => jobAttributeRowsPageSchema.safeParse(body),
      BULK_ROWS_UNAVAILABLE_TEXT,
    );
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
        : { ok: false, message: ATTRIBUTE_REFUSED_TEXT };
    } catch {
      return {
        ok: false,
        message: attributeAnswerMessage(0, null),
      };
    }
  }

  private async read<T>(
    path: string,
    parse: (body: unknown) => { success: true; data: T } | { success: false },
    invalidText: string,
  ): Promise<AttributeFlowAnswer<T>> {
    try {
      const response = await this.auth.request(path);
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        return {
          ok: false,
          message: attributeAnswerMessage(response.status, body),
        };
      const parsed = parse(body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, message: invalidText };
    } catch {
      return {
        ok: false,
        message: attributeAnswerMessage(0, null),
      };
    }
  }
}
