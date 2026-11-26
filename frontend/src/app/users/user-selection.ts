import { signal } from '@angular/core';
import { z } from 'zod';
import type {
  SelectionOp,
  SelectionSpec,
  ServerSideSelectionProvider,
} from '@libregrid/server-side-selection';
import {
  userSelectionKeySchema,
  userSelectionSpecSchema,
  type UserPredicate,
  type UserSelectionKey,
  type UserSelectionOp,
  type UserSelectionSpec,
} from '@campus/application-contracts';
import { chipLabel, type UserAttributeColumn } from './user-fields';
import {
  filterModelFromPredicates,
  gridExpresses,
  mergeGridPredicates,
  predicatesFromFilterModel,
} from './user-filter-model';

export const USER_GRID_ID = 'users' as const;
const tabStorageKey = 'cc.users.selection-tab';
const idBatch = 2000;
const opBatch = 100;
/** The edge accepts 96 KiB bodies. Lists and operation groups stay well inside that. */
const listBudget = 28 * 1024;
const opsBudget = 56 * 1024;
const encoder = new TextEncoder();

/** Split a list in order, so each part serializes within the budget and holds at most `most` items. */
function sized<T>(items: readonly T[], budget: number, most: number): T[][] {
  const parts: T[][] = [];
  let part: T[] = [];
  let size = 2;
  for (const item of items) {
    const itemSize = encoder.encode(JSON.stringify(item)).length + 1;
    if (part.length && (size + itemSize > budget || part.length >= most)) {
      parts.push(part);
      part = [];
      size = 2;
    }
    part.push(item);
    size += itemSize;
  }
  if (part.length) parts.push(part);
  return parts;
}

function browserSession(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Each browser tab keeps its own selection. A reload in the same tab keeps it. */
export function userSelectionTab(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserSession(),
): string {
  try {
    const saved = storage?.getItem(tabStorageKey);
    if (saved && z.uuid().safeParse(saved).success) return saved;
    const created = crypto.randomUUID();
    storage?.setItem(tabStorageKey, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function key(params: { gridId: string; tabId: string }): UserSelectionKey {
  return userSelectionKeySchema.parse({
    gridId: params.gridId,
    tabId: params.tabId,
  });
}

/** The grid's filters, so Select All captures the query the person sees. */
export interface SelectionContext {
  predicates: UserPredicate[];
  attributes: readonly UserAttributeColumn[];
}
const flat = (): SelectionContext => ({ predicates: [], attributes: [] });

function userOps(
  op: SelectionOp,
  context: SelectionContext,
  pending: readonly string[] | null,
): UserSelectionOp[] {
  switch (op.op) {
    case 'selectAll':
      // The pending view holds one set of users, not the directory. Select All names those
      // IDs, so the server never reads the empty pending filter as the whole directory
      // (R1-A).
      if (pending?.length) return [{ op: 'select', ids: [...pending] }];
      return [
        {
          op: 'selectAll',
          predicates: mergeGridPredicates(
            predicatesFromFilterModel(op.filter, context.attributes),
            context.predicates.filter((predicate) => !gridExpresses(predicate)),
          ),
        },
      ];
    case 'deselectAll':
      return [{ op: 'deselectAll' }];
    case 'select':
    case 'deselect': {
      const batches: UserSelectionOp[] = [];
      for (const ids of sized(op.ids, listBudget, idBatch))
        batches.push({ op: op.op, ids });
      return batches;
    }
    // The users grid has no grouping, so it reports no group operation.
    case 'selectGroup':
    case 'deselectGroup':
      return [];
  }
}

/** A request of the selection provider. The owner check fences a stale answer. */
export type SelectionCall = (
  path: string,
  body: unknown,
  owns: () => boolean,
) => Promise<Response | null>;

const EMPTY_SPEC = (): SelectionSpec => ({ terms: [], selectedCount: 0 });

function gridSpec(
  spec: UserSelectionSpec,
  attributes: readonly UserAttributeColumn[],
): SelectionSpec {
  return {
    terms: spec.terms.map((term) => ({
      type: 'all' as const,
      filter: filterModelFromPredicates(term.predicates, attributes),
    })),
    selectedCount: spec.selectedCount,
  };
}

/**
 * The LibreGrid selection provider for the users grid. The API keeps the selection.
 *
 * Answers are fenced twice. A reset (another person signed in) invalidates every
 * request that an earlier person started. A spec read publishes only while no
 * selection change and no newer read came after it began, so an old answer never
 * replaces a newer selection (R1, R9).
 */
export class UserSelectionProvider implements ServerSideSelectionProvider {
  /** The latest selection that the API reported, for the status bar. */
  readonly spec = signal<UserSelectionSpec | null>(null);
  /**
   * Counts every applied selection change. The spec holds counts, so a same-count
   * row replacement leaves it unchanged. This count tells those changes apart.
   */
  readonly revision = signal(0);

  /** Bumps when another person signs in. Answers of the earlier person never publish. */
  private epoch = 0;
  /** Bumps when a selection change starts. A superseded change stops its later batches. */
  private writeTicket = 0;
  /** Counts the published selection changes. A read taken before one stays unpublished. */
  private publishedWrites = 0;
  /** Numbers the started reads. An older read never restores a count that a newer one replaced. */
  private readTicket = 0;
  /** The users of the pending view, or null while the grid shows the query (R1-A). */
  private pendingIds: readonly string[] | null = null;

  constructor(
    private readonly call: SelectionCall,
    private readonly context: () => SelectionContext = flat,
  ) {}

  /** Another person signed in. Drop the selection of the earlier person and fence its answers. */
  reset(): void {
    this.epoch++;
    this.writeTicket++;
    this.publishedWrites++;
    this.pendingIds = null;
    this.spec.set(null);
  }

  /**
   * The grid shows the pending view of these users, or the query when the list is null.
   * Select All then names these IDs instead of the directory (R1-A).
   */
  setPending(ids: readonly string[] | null): void {
    const next = ids?.length ? [...new Set(ids)] : null;
    if (
      next === this.pendingIds ||
      (next !== null &&
        this.pendingIds !== null &&
        next.length === this.pendingIds.length &&
        next.every((id, index) => id === this.pendingIds![index]))
    )
      return;
    this.pendingIds = next;
    // The visible selection starts empty for the new scope. The server keeps the tab's
    // selection, and leaving the pending view reads it again (R1-A).
    this.clear();
  }

  /** A change ended the selection. Show it as empty before the provider reads it again (R10). */
  clear(): void {
    this.writeTicket++;
    this.publishedWrites++;
    this.spec.set({
      terms: [],
      added: 0,
      excluded: 0,
      selectedCount: 0,
      expiredAt: new Date().toISOString(),
    });
  }

  private owns(epoch: number): boolean {
    return epoch === this.epoch;
  }

  /** Sends one request. Null means a principal change fenced the answer. */
  private async send(
    path: string,
    body: unknown,
    epoch: number,
  ): Promise<unknown | null> {
    if (!this.owns(epoch)) return null;
    const response = await this.call(`/api/users/selection${path}`, body, () =>
      this.owns(epoch),
    );
    if (!this.owns(epoch)) return null;
    if (!response?.ok) throw new Error('The user selection is unavailable.');
    const decoded: unknown = await response.json();
    // The body decodes after the request answers. A reset can land while it decodes (R1).
    return this.owns(epoch) ? decoded : null;
  }

  private parsed(body: unknown): UserSelectionSpec | null {
    const result = userSelectionSpecSchema.safeParse(
      (body as { selection?: unknown } | null)?.selection,
    );
    return result.success ? result.data : null;
  }

  async getSpec(params: {
    gridId: string;
    tabId: string;
  }): Promise<SelectionSpec> {
    const epoch = this.epoch;
    const writes = this.publishedWrites;
    // The newest read owns the published count (R9).
    const read = ++this.readTicket;
    const spec = this.parsed(await this.send('', key(params), epoch));
    if (!spec || !this.owns(epoch)) return EMPTY_SPEC();
    if (read !== this.readTicket || writes !== this.publishedWrites) {
      // A newer read or a selection change replaced this answer. Show the current selection.
      const current = this.spec();
      return current
        ? gridSpec(current, this.context().attributes)
        : EMPTY_SPEC();
    }
    this.spec.set(spec);
    return gridSpec(spec, this.context().attributes);
  }

  async applyOps(params: {
    gridId: string;
    tabId: string;
    ops: SelectionOp[];
  }): Promise<void> {
    const epoch = this.epoch;
    const context = this.context();
    let ops: UserSelectionOp[];
    try {
      ops = params.ops.flatMap((op) => userOps(op, context, this.pendingIds));
    } catch {
      // A filter the query cannot express matches no row, so there is nothing to select.
      return;
    }
    if (!ops.length) return;
    const ticket = ++this.writeTicket;
    for (const part of sized(ops, opsBudget, opBatch)) {
      if (!this.owns(epoch) || ticket !== this.writeTicket) return;
      const spec = this.parsed(
        await this.send('/ops', { ...key(params), ops: part }, epoch),
      );
      if (!this.owns(epoch) || ticket !== this.writeTicket || !spec) return;
      this.spec.set(spec);
      this.publishedWrites++;
    }
    if (this.owns(epoch)) this.revision.update((value) => value + 1);
  }

  async resolveSelected(params: {
    gridId: string;
    tabId: string;
    rowIds: string[];
    groupRoutes: string[];
  }): Promise<Record<string, boolean>> {
    const epoch = this.epoch;
    const context = this.context();
    const selected: Record<string, boolean> = {};
    const rows = sized(params.rowIds, listBudget, idBatch);
    const batches = Math.max(1, rows.length);
    for (let batch = 0; batch < batches; batch++) {
      if (!this.owns(epoch)) return {};
      const body = await this.send(
        '/resolve',
        {
          ...key(params),
          rowIds: rows[batch] ?? [],
          predicates: context.predicates,
        },
        epoch,
      );
      // A reset discards the rows read under the earlier person, accumulated batches too (R1).
      if (body === null || !this.owns(epoch)) return {};
      Object.assign(
        selected,
        z
          .record(z.string(), z.boolean())
          .parse((body as { selected?: unknown }).selected),
      );
    }
    return selected;
  }
}

/** What Select All captured, with explicit changes (SELECT-01). */
export function selectionScope(
  spec: UserSelectionSpec | null,
  attributes: readonly UserAttributeColumn[] = [],
): string {
  if (!spec || !spec.terms.length) return '';
  const terms = spec.terms
    .map((term) =>
      term.predicates.length
        ? term.predicates
            .map((item) => chipLabel(item, attributes))
            .join(' and ')
        : 'All users',
    )
    .join('; ');
  return [
    ...(terms ? [`Selected by filter: ${terms}`] : []),
    ...(spec.added ? [`${spec.added} added`] : []),
    ...(spec.excluded ? [`${spec.excluded} excluded`] : []),
  ].join(' · ');
}
