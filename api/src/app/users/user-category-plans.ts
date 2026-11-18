import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  USER_ATTRIBUTE_CATEGORY_LIMIT,
  USER_ATTRIBUTE_FIELD_LIMIT,
  userAttributeCategoriesSchema,
  userAttributeCategoryJobReceiptSchema,
  userAttributeCategoryPlanSchema,
  type SessionResponse,
  type UserAttributeCategory,
  type UserAttributeCategoryDraftField,
  type UserAttributeField,
  type UserAttributeCategoryJobReceipt,
  type UserAttributeCategoryPlan,
  type UserAttributeCategoryPlanChange,
  type UserAttributeCategoryPlanConfirmRequest,
  type UserAttributeCategoryPlanKind,
  type UserAttributeCategoryPlanRequest,
  type UserAttributeRange,
} from '@campus/application-contracts';

/** A category plan expires 15 minutes after it was prepared (B section 10). */
export const USER_CATEGORY_PLAN_MINUTES = 15;
/** The schema-manage base adds the customer and the generation that a plan freezes. */
export const userCategoryPlanBaseSchema = userAttributeCategoriesSchema.extend({
  customerId: z.string().min(1).max(64),
  generation: z.number().int().positive(),
});
export type UserCategoryPlanBase = z.infer<typeof userCategoryPlanBaseSchema>;

/** The one Google method of each plan kind. */
const CATEGORY_PLAN_METHODS: Readonly<
  Record<UserAttributeCategoryPlanKind, 'insert' | 'update' | 'delete'>
> = {
  'create-category': 'insert',
  'edit-category': 'update',
  'delete-category': 'delete',
};

/** One attribute of the frozen Google body (B section 6.1). A kept field carries its cached ID. */
export interface UserCategoryPlanFieldBody {
  fieldId?: string;
  fieldName: string;
  displayName: string;
  fieldType: string;
  multiValued: boolean;
  indexed: boolean;
  readAccessType: string;
  numericIndexingSpec?: UserAttributeRange;
}

/** The frozen call of one editor save. The route stores it; the worker (K16) sends it. */
export interface CategoryPlanDraft {
  kind: UserAttributeCategoryPlanKind;
  method: 'insert' | 'update' | 'delete';
  schemaId: string | null;
  schemaName: string;
  displayName: string;
  baseEtag: string | null;
  body: Record<string, unknown> | null;
  changes: UserAttributeCategoryPlanChange[];
  phrase: string | null;
  digest: string;
}

/** The plan plus the customer and generation that its job freezes. */
export interface UserCategoryPlanStore extends CategoryPlanDraft {
  customerId: string;
  generation: number;
  expiresMinutes: number;
}

/** The cache, the person check, and the stored plans of the plan routes. */
export interface UserCategoryPlanPort {
  /** The cached set under the schema-manage gate. Null means no connection. */
  base(session: SessionResponse): Promise<UserCategoryPlanBase | null>;
  /** Require `users:schema-manage` at the connected customer's district scope. */
  authorize(
    session: SessionResponse,
    customerId: string,
    correlationId: string,
  ): Promise<void>;
  /** Re-read the cache, then store the plan (C7). */
  create(
    session: SessionResponse,
    plan: UserCategoryPlanStore,
  ): Promise<unknown>;
  /** The plan, to its creator only. */
  read(session: SessionResponse, planId: string): Promise<unknown>;
  /** Create the one category job, or answer its receipt again. */
  confirm(
    session: SessionResponse,
    planId: string,
    digest: string,
    phrase: string | null,
    correlationId: string,
  ): Promise<unknown>;
}

const foldedDisplayName = (value: string): string => value.trim().toLowerCase();
const visibleDisplayName = (value: string): boolean => value.trim().length > 0;

/** A number range compares by its two bounds. */
function sameRange(
  left: UserAttributeRange | null,
  right: UserAttributeRange | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.minValue === right.minValue && left.maxValue === right.maxValue;
}

/**
 * C3: an edit keeps the cached range of a kept attribute. The editor draws no range input before
 * K19, so a draft that names no range keeps the cached one. A named range replaces it.
 */
function keptRange(
  draft: UserAttributeCategoryDraftField,
  cached: UserAttributeField,
): UserAttributeRange | null {
  return draft.numericIndexingSpec ?? cached.numericIndexingSpec;
}

/** 422 `display-name-in-use` (C2). */
function displayNameInUse(): never {
  throw new UnprocessableEntityException({ reason: 'display-name-in-use' });
}

/** 422 `invalid-display-name`: a display name needs a visible character (B section 5). */
function invalidDisplayName(): never {
  throw new UnprocessableEntityException({ reason: 'invalid-display-name' });
}

/** 422 `name-in-use` (B section 13). */
function nameInUse(): never {
  throw new UnprocessableEntityException({ reason: 'name-in-use' });
}

/** 422 `locked-property`: Google cannot change the name, the type, or many values to one. */
function lockedProperty(message: string): never {
  throw new UnprocessableEntityException({
    reason: 'locked-property',
    message,
  });
}

/** 422 `nothing-to-update`: the edit changes no label and no attribute. */
function nothingToUpdate(): never {
  throw new UnprocessableEntityException({ reason: 'nothing-to-update' });
}

/** 412 `category-changed`: the cached `etag` differs from the plan base (C7). */
function categoryChanged(): never {
  throw new HttpException(
    { reason: 'category-changed' },
    HttpStatus.PRECONDITION_FAILED,
  );
}

/** 400 `invalid-plan`: the draft names a field that the cached category does not hold. */
function invalidPlan(message: string): never {
  throw new BadRequestException({ reason: 'invalid-plan', message });
}

/**
 * C2: a new or changed display name differs from every other display name of its category, after
 * trimming and case folding. A display name that Google already holds stays valid until the person
 * changes it.
 */
function checkDisplayNames(
  fields: readonly UserAttributeCategoryDraftField[],
  cached: ReadonlyMap<string, UserAttributeField>,
  allNew: boolean,
): void {
  const names = fields.map((field) => foldedDisplayName(field.displayName));
  fields.forEach((field, index) => {
    const held = field.fieldId === null ? undefined : cached.get(field.fieldId);
    const changed =
      allNew ||
      field.fieldId === null ||
      held === undefined ||
      field.displayName !== held.displayName;
    if (!changed) return;
    if (!visibleDisplayName(field.displayName)) invalidDisplayName();
    if (names.some((name, other) => other !== index && name === names[index]))
      displayNameInUse();
  });
}

/** An added attribute name differs from every kept attribute and from every other new one. */
function checkAddedNames(
  fields: readonly UserAttributeCategoryDraftField[],
  kept: ReadonlySet<string>,
): void {
  const added = new Set<string>();
  for (const field of fields) {
    if (field.fieldId !== null) continue;
    const name = field.fieldName.toLowerCase();
    if (kept.has(name) || added.has(name)) nameInUse();
    added.add(name);
  }
}

/** The 100-category and 100-attribute limits of the account, with the save counted (B section 5). */
function checkLimits(categories: number, attributes: number): void {
  if (categories > USER_ATTRIBUTE_CATEGORY_LIMIT)
    throw new UnprocessableEntityException({ reason: 'category-limit' });
  if (attributes > USER_ATTRIBUTE_FIELD_LIMIT)
    throw new UnprocessableEntityException({ reason: 'attribute-limit' });
}

/** The body of one new attribute. Google assigns its field ID. */
function newFieldBody(
  field: UserAttributeCategoryDraftField,
): UserCategoryPlanFieldBody {
  return {
    fieldName: field.fieldName,
    displayName: field.displayName,
    fieldType: field.fieldType,
    multiValued: field.multiValued,
    indexed: field.indexed,
    readAccessType: field.readAccessType,
    ...(field.numericIndexingSpec
      ? { numericIndexingSpec: field.numericIndexingSpec }
      : {}),
  };
}

/** The body of one kept attribute: every property of the cache, the range included (C3). */
function keptFieldBody(
  field: UserAttributeCategoryDraftField,
  cached: UserAttributeField,
): UserCategoryPlanFieldBody {
  const range = keptRange(field, cached);
  return {
    fieldId: cached.fieldId,
    fieldName: cached.fieldName,
    displayName: field.displayName,
    fieldType: cached.fieldType,
    multiValued: field.multiValued,
    indexed: field.indexed,
    readAccessType: field.readAccessType,
    ...(range ? { numericIndexingSpec: range } : {}),
  };
}

/** The plan properties that an edit moves, in contract order. */
function changedProperties(
  field: UserAttributeCategoryDraftField,
  cached: UserAttributeField,
): UserAttributeCategoryPlanChange['properties'] {
  const properties: UserAttributeCategoryPlanChange['properties'] = [];
  if (field.displayName !== cached.displayName) properties.push('displayName');
  if (field.multiValued !== cached.multiValued) properties.push('multiValued');
  if (field.indexed !== cached.indexed) properties.push('indexed');
  if (field.readAccessType !== cached.readAccessType)
    properties.push('readAccessType');
  if (!sameRange(keptRange(field, cached), cached.numericIndexingSpec))
    properties.push('numericIndexingSpec');
  return properties;
}

const addedChange = (
  field: UserAttributeCategoryDraftField,
): UserAttributeCategoryPlanChange => ({
  change: 'added',
  fieldId: null,
  fieldName: field.fieldName,
  displayName: field.displayName,
  properties: [],
  holders: null,
});

const changedChange = (
  field: UserAttributeCategoryDraftField,
  cached: UserAttributeField,
  properties: UserAttributeCategoryPlanChange['properties'],
): UserAttributeCategoryPlanChange => ({
  change: 'changed',
  fieldId: cached.fieldId,
  fieldName: cached.fieldName,
  displayName: field.displayName,
  properties,
  holders: null,
});

const removedChange = (
  field: UserAttributeField,
): UserAttributeCategoryPlanChange => ({
  change: 'removed',
  fieldId: field.fieldId,
  fieldName: field.fieldName,
  displayName: field.displayName,
  properties: [],
  holders: field.holders,
});

/**
 * The digest that the confirm names. It covers the frozen call and the change plan, so a changed
 * body, range, or phrase answers `plan-changed` at confirm.
 */
export function categoryPlanDigest(
  plan: Omit<CategoryPlanDraft, 'digest'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        actionVersion: 1,
        kind: plan.kind,
        schemaId: plan.schemaId,
        baseEtag: plan.baseEtag,
        schemaName: plan.schemaName,
        displayName: plan.displayName,
        body: plan.body,
        changes: plan.changes,
        phrase: plan.phrase,
      }),
    )
    .digest('hex');
}

/** Find the cached category that the plan names, or answer 412 (C7). */
function cachedCategory(
  base: UserCategoryPlanBase,
  schemaId: string,
  baseEtag: string,
): UserAttributeCategory {
  const category = base.categories.find(
    (candidate) => candidate.schemaId === schemaId,
  );
  if (!category || category.etag !== baseEtag) categoryChanged();
  return category;
}

function createPlan(
  request: Extract<
    UserAttributeCategoryPlanRequest,
    { kind: 'create-category' }
  >,
  base: UserCategoryPlanBase,
): CategoryPlanDraft {
  const draft = request.draft;
  if (!visibleDisplayName(draft.displayName)) invalidDisplayName();
  if (
    base.categories.some(
      (category) =>
        category.schemaName.toLowerCase() === draft.schemaName.toLowerCase(),
    )
  )
    nameInUse();
  checkAddedNames(draft.fields, new Set<string>());
  checkDisplayNames(draft.fields, new Map<string, UserAttributeField>(), true);
  checkLimits(
    base.limits.categories + 1,
    base.limits.attributes + draft.fields.length,
  );
  const plan = {
    kind: request.kind,
    method: CATEGORY_PLAN_METHODS[request.kind],
    schemaId: null,
    schemaName: draft.schemaName,
    displayName: draft.displayName,
    baseEtag: null,
    body: {
      schemaName: draft.schemaName,
      displayName: draft.displayName,
      fields: draft.fields.map(newFieldBody),
    },
    changes: draft.fields.map(addedChange),
    phrase: null,
  } satisfies Omit<CategoryPlanDraft, 'digest'>;
  return { ...plan, digest: categoryPlanDigest(plan) };
}

function editPlan(
  request: Extract<UserAttributeCategoryPlanRequest, { kind: 'edit-category' }>,
  base: UserCategoryPlanBase,
): CategoryPlanDraft {
  const draft = request.draft;
  if (!visibleDisplayName(draft.displayName)) invalidDisplayName();
  const category = cachedCategory(base, request.schemaId, request.baseEtag);
  const cachedById = new Map(
    category.fields.map((field) => [field.fieldId, field]),
  );
  const kept = new Set<string>();
  for (const field of draft.fields) {
    if (field.fieldId === null) continue;
    const cached = cachedById.get(field.fieldId);
    if (!cached)
      invalidPlan('A kept attribute names a field of the cached category.');
    if (kept.has(field.fieldId))
      invalidPlan('An attribute occurs once in an edit.');
    kept.add(field.fieldId);
    if (field.fieldName !== cached.fieldName)
      lockedProperty('Google does not allow renaming an attribute.');
    if (field.fieldType !== cached.fieldType)
      lockedProperty('Google does not allow changing the info type.');
    if (cached.multiValued && !field.multiValued)
      lockedProperty(
        'Google does not allow changing multiple values back to one value.',
      );
  }
  const keptNames = new Set(
    draft.fields
      .filter((field) => field.fieldId !== null)
      .map((field) => field.fieldName.toLowerCase()),
  );
  checkAddedNames(draft.fields, keptNames);
  checkDisplayNames(draft.fields, cachedById, false);
  const cachedKept = draft.fields
    .filter((field) => field.fieldId !== null)
    .map((field) => ({
      field,
      cached: cachedById.get(field.fieldId as string) as UserAttributeField,
    }));
  const added = draft.fields.filter((field) => field.fieldId === null);
  const removed = category.fields.filter((field) => !kept.has(field.fieldId));
  const changes: UserAttributeCategoryPlanChange[] = [
    ...added.map(addedChange),
    ...cachedKept.flatMap(({ field, cached }) => {
      const properties = changedProperties(field, cached);
      return properties.length
        ? [changedChange(field, cached, properties)]
        : [];
    }),
    ...removed.map(removedChange),
  ];
  if (changes.length === 0 && draft.displayName === category.displayName)
    nothingToUpdate();
  checkLimits(
    base.limits.categories,
    base.limits.attributes - removed.length + added.length,
  );
  const plan = {
    kind: request.kind,
    method: CATEGORY_PLAN_METHODS[request.kind],
    schemaId: category.schemaId,
    schemaName: category.schemaName,
    displayName: draft.displayName,
    baseEtag: request.baseEtag,
    body: {
      schemaName: category.schemaName,
      displayName: draft.displayName,
      // B section 6.1: every kept field with its fieldId, then each new field.
      fields: [
        ...cachedKept.map(({ field, cached }) => keptFieldBody(field, cached)),
        ...added.map(newFieldBody),
      ],
    },
    changes,
    phrase:
      changes.find((change) => change.change === 'removed')?.fieldName ?? null,
  } satisfies Omit<CategoryPlanDraft, 'digest'>;
  return { ...plan, digest: categoryPlanDigest(plan) };
}

function deletePlan(
  request: Extract<
    UserAttributeCategoryPlanRequest,
    { kind: 'delete-category' }
  >,
  base: UserCategoryPlanBase,
): CategoryPlanDraft {
  const category = cachedCategory(base, request.schemaId, request.baseEtag);
  const plan = {
    kind: request.kind,
    method: CATEGORY_PLAN_METHODS[request.kind],
    schemaId: category.schemaId,
    schemaName: category.schemaName,
    displayName: category.displayName,
    baseEtag: request.baseEtag,
    body: null,
    changes: category.fields.map(removedChange),
    // A delete types the category display name (B section 5).
    phrase: category.displayName,
  } satisfies Omit<CategoryPlanDraft, 'digest'>;
  return { ...plan, digest: categoryPlanDigest(plan) };
}

/**
 * Build the one Google call, its attribute changes, its typed phrase, and its digest (B section
 * 6.1). The rules of B section 5 and C2 answer 422 before any plan is stored. C3 keeps the cached
 * range of every kept field.
 */
export function buildCategoryPlan(
  request: UserAttributeCategoryPlanRequest,
  base: UserCategoryPlanBase,
): CategoryPlanDraft {
  if (request.kind === 'create-category') return createPlan(request, base);
  if (request.kind === 'edit-category') return editPlan(request, base);
  return deletePlan(request, base);
}

function measuredAt(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null;
}

/** One function answer, as an object. */
function resultOf(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new ServiceUnavailableException({
      reason: 'user-schema-unavailable',
    });
  return parsed.data;
}

/** Map one stored-plan function outcome to the status and code of B section 13. */
function planFunctionError(result: Record<string, unknown>): never {
  const outcome = String(result['outcome']);
  if (outcome === 'forbidden')
    throw new ForbiddenException({ reason: 'forbidden' });
  if (outcome === 'not-found')
    throw new NotFoundException({ reason: 'plan-not-found' });
  if (outcome === 'plan-expired')
    throw new GoneException({
      reason: 'plan-expired',
      expiresAt: measuredAt(result['expiresAt']),
    });
  if (outcome === 'category-changed') categoryChanged();
  if (outcome === 'plan-changed' || outcome === 'connection-changed')
    throw new ConflictException({ reason: outcome });
  if (
    outcome === 'name-in-use' ||
    outcome === 'display-name-in-use' ||
    outcome === 'category-limit' ||
    outcome === 'attribute-limit' ||
    outcome === 'nothing-to-update' ||
    outcome === 'phrase-mismatch'
  )
    throw new UnprocessableEntityException({ reason: outcome });
  throw new ServiceUnavailableException({ reason: 'user-schema-unavailable' });
}

function planOf(result: Record<string, unknown>): UserAttributeCategoryPlan {
  return userAttributeCategoryPlanSchema.parse(result['plan']);
}

function receiptOf(
  result: Record<string, unknown>,
): UserAttributeCategoryJobReceipt {
  return userAttributeCategoryJobReceiptSchema.parse(result['receipt']);
}

/** The plan and confirm routes of document B section 10. */
export class UserCategoryPlans {
  private readonly port: UserCategoryPlanPort;

  constructor(port: UserCategoryPlanPort) {
    this.port = port;
  }

  /** Freeze one editor save. The plan base re-reads the cache before the store (C7). */
  async plan(
    session: SessionResponse,
    request: UserAttributeCategoryPlanRequest,
    correlationId: string,
  ): Promise<UserAttributeCategoryPlan> {
    const base = await this.port.base(session);
    if (!base) throw new ConflictException({ reason: 'connection-required' });
    await this.port.authorize(session, base.customerId, correlationId);
    const draft = buildCategoryPlan(request, base);
    const result = resultOf(
      await this.port.create(session, {
        ...draft,
        customerId: base.customerId,
        generation: base.generation,
        expiresMinutes: USER_CATEGORY_PLAN_MINUTES,
      }),
    );
    if (result['outcome'] !== 'created') planFunctionError(result);
    return planOf(result);
  }

  /** The plan, to its creator only (B section 10). */
  async byId(
    session: SessionResponse,
    planId: string,
    correlationId: string,
  ): Promise<UserAttributeCategoryPlan> {
    const result = resultOf(await this.port.read(session, planId));
    if (result['outcome'] !== 'plan') planFunctionError(result);
    await this.port.authorize(
      session,
      String(result['customerId']),
      correlationId,
    );
    return planOf(result);
  }

  /**
   * Confirm one plan. The route trims the typed phrase, and the function compares it exactly (B
   * section 5). A repeated confirm answers the same receipt.
   */
  async confirm(
    session: SessionResponse,
    planId: string,
    input: UserAttributeCategoryPlanConfirmRequest,
    correlationId: string,
  ): Promise<{ receipt: UserAttributeCategoryJobReceipt; existing: boolean }> {
    // The plan read answers the connected customer before the person check, so a missing or
    // expired plan never reaches the job function.
    const plan = resultOf(await this.port.read(session, planId));
    if (plan['outcome'] !== 'plan') planFunctionError(plan);
    await this.port.authorize(
      session,
      String(plan['customerId']),
      correlationId,
    );
    const phrase =
      input.typedPhrase === undefined ? null : input.typedPhrase.trim();
    const result = resultOf(
      await this.port.confirm(
        session,
        planId,
        input.digest,
        phrase,
        correlationId,
      ),
    );
    const outcome = String(result['outcome']);
    if (outcome === 'created')
      return { receipt: receiptOf(result), existing: false };
    if (outcome === 'existing')
      return { receipt: receiptOf(result), existing: true };
    return planFunctionError(result);
  }
}
