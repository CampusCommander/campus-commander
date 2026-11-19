import { z } from 'zod';
import type { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CAPABILITIES,
  USER_ATTRIBUTE_CATEGORY_LIMIT,
  USER_ATTRIBUTE_FIELD_LIMIT,
  googleCustomerIdSchema,
  userAttributeCategoryObservationSchema,
  userAttributeFieldTypeSchema,
  userAttributeVisibilitySchema,
  userCustomSchemasSchema,
  userObservationSchema,
  type UserAttributeCategoryObservation,
  type UserAttributeFieldType,
  type UserAttributeVisibility,
  type UserObservation,
} from '@campus/application-contracts';
import type { DelegatedCredential } from './credential';
import {
  BATCH_DEFAULTS,
  BatchServiceError,
  GoogleBatchService,
  type BatchFailure,
  type BatchRequest,
  type BatchResult,
} from './batch';
import { GoogleConnectionError, failure, scopedClient } from './provider';

const directory = 'https://admin.googleapis.com/admin/directory/v1';
const batchEndpoint = 'https://www.googleapis.com/batch/admin/directory_v1';
const directoryPath = '/admin/directory/v1';
/** A full page of 500 users with values stays under this. */
const userPageLimit = 4 * 1024 * 1024;
/** 500 chatty users with long values stay under this. */
const batchResponseLimit = 4 * 1024 * 1024;
const maximumPages = 10_000;
const batchLimit = 1000;
/** A section 6 reads 100 users per refresh batch. */
const userReadBatchSize = 100;
const tokenRenewalMilliseconds = 45 * 60_000;
/** The category read deadline of B section 9. */
const categoryDeadlineMilliseconds = 25_000;
/** Google reports a user that never signed in at the Unix epoch. */
const neverSignedIn = Date.parse('1970-01-01T00:00:00.000Z');

/** The user fields of A section 6, without the list wrapper. */
const userFields =
  'id,primaryEmail,name(givenName,familyName,fullName),orgUnitPath,suspended,suspensionReason,archived,lastLoginTime,creationTime,isEnrolledIn2Sv,organizations(primary,department,title),aliases,customSchemas';
const userListFields = `nextPageToken,users(${userFields})`;
/** The category fields of B section 3, without the list wrapper. */
const categoryFields =
  'schemas(schemaId,schemaName,displayName,etag,fields(fieldId,fieldName,displayName,fieldType,multiValued,indexed,readAccessType,numericIndexingSpec(minValue,maxValue)))';

const userResource = z.object({
  id: z.string().min(1).max(128),
  primaryEmail: z.email().max(254),
  orgUnitPath: z.string().min(1).max(4096).startsWith('/'),
  name: z
    .object({
      givenName: z.string().max(256).optional(),
      familyName: z.string().max(256).optional(),
      fullName: z.string().max(4096).optional(),
    })
    .optional(),
  suspended: z.boolean().optional(),
  suspensionReason: z.string().max(4096).optional(),
  archived: z.boolean().optional(),
  lastLoginTime: z.string().max(64).optional(),
  creationTime: z.string().max(64).optional(),
  isEnrolledIn2Sv: z.boolean().optional(),
  aliases: z.array(z.email().max(254)).max(1000).optional(),
  organizations: z
    .array(
      z.object({
        primary: z.boolean().optional(),
        department: z.string().max(4096).optional(),
        title: z.string().max(4096).optional(),
      }),
    )
    .max(1000)
    .optional(),
  customSchemas: userCustomSchemasSchema.optional(),
});
type DirectoryUser = z.infer<typeof userResource>;

const userPage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  users: z.array(userResource).max(500).optional(),
});

const categoryFieldResource = z.object({
  fieldId: z.string().min(1).max(200),
  fieldName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  fieldType: userAttributeFieldTypeSchema,
  multiValued: z.boolean().optional(),
  indexed: z.boolean().optional(),
  readAccessType: userAttributeVisibilitySchema.optional(),
  numericIndexingSpec: z
    .object({
      minValue: z.number().optional(),
      maxValue: z.number().optional(),
    })
    .optional(),
});
type CategoryResource = z.infer<typeof categoryResource>;

const categoryResource = z.object({
  schemaId: z.string().min(1).max(200),
  schemaName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  etag: z.string().min(1).max(200),
  fields: z.array(categoryFieldResource).min(1).max(USER_ATTRIBUTE_FIELD_LIMIT),
});

const categoryPage = z.object({
  schemas: z
    .array(categoryResource)
    .max(USER_ATTRIBUTE_CATEGORY_LIMIT)
    .optional(),
});

function scopeFor(
  id: 'user-inventory' | 'user-schemas' | 'user-schema-changes',
): string {
  return GOOGLE_CAPABILITIES.find((capability) => capability.id === id)!.scope;
}

function blank(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

function instant(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The last sign-in of a user. A user that never signed in keeps no time. */
export function lastLoginTime(value: string | undefined): string | null {
  const time = instant(value);
  return time !== null && Date.parse(time) === neverSignedIn ? null : time;
}

/** The department and title come from the primary organization, else the first. */
function primaryOrganization(organizations: DirectoryUser['organizations']) {
  return (
    organizations?.find((organization) => organization.primary === true) ??
    organizations?.[0]
  );
}

/** Map one Google user resource to the observation that the cache stores (A section 7). */
export function userObservation(user: DirectoryUser): UserObservation {
  const organization = primaryOrganization(user.organizations);
  return userObservationSchema.parse({
    userId: user.id,
    primaryEmail: user.primaryEmail,
    orgUnitPath: user.orgUnitPath,
    givenName: blank(user.name?.givenName),
    familyName: blank(user.name?.familyName),
    fullName: blank(user.name?.fullName),
    suspended: user.suspended ?? false,
    suspensionReason: blank(user.suspensionReason),
    archived: user.archived ?? false,
    lastLoginTime: lastLoginTime(user.lastLoginTime),
    creationTime: instant(user.creationTime),
    twoStepEnrolled: user.isEnrolledIn2Sv ?? false,
    department: blank(organization?.department),
    title: blank(organization?.title),
    aliases: user.aliases ?? [],
    // The raw object is stored unchanged, so document B reads the Google form.
    customSchemas: user.customSchemas ?? {},
  });
}

/** Map one Google schema resource to the category observation that the cache stores. */
export function categoryObservation(
  category: CategoryResource,
): UserAttributeCategoryObservation {
  return userAttributeCategoryObservationSchema.parse({
    schemaId: category.schemaId,
    schemaName: category.schemaName,
    displayName: category.displayName,
    etag: category.etag,
    fields: category.fields.map((field) => ({
      fieldId: field.fieldId,
      fieldName: field.fieldName,
      displayName: field.displayName,
      fieldType: field.fieldType,
      // Google applies these defaults to a field that names none (B section 3).
      multiValued: field.multiValued ?? false,
      indexed: field.indexed ?? true,
      readAccessType: field.readAccessType ?? 'ALL_DOMAIN_USERS',
      numericIndexingSpec: field.numericIndexingSpec
        ? {
            minValue: field.numericIndexingSpec.minValue ?? null,
            maxValue: field.numericIndexingSpec.maxValue ?? null,
          }
        : null,
    })),
  });
}

const quotaBackoff = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);

/** Wait for a quota backoff. An abort ends the wait with the quota failure. */
async function quotaSleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new GoogleConnectionError('quota');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new GoogleConnectionError('quota'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

/** Map a final batch failure to the existing failure vocabulary. */
function batchFailure(failed: BatchFailure): GoogleConnectionError {
  if (failed.kind === 'quota') return new GoogleConnectionError('quota');
  if (failed.kind === 'invalid-response')
    return new GoogleConnectionError('invalid-response');
  if (failed.kind === 'aborted' || failed.status === 0)
    return new GoogleConnectionError('network-failure');
  return failure({ response: { status: failed.status, data: failed.body } });
}

export interface GoogleUserReaderOptions {
  batch?: GoogleBatchService;
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
  backoff?(attempt: number): number;
}

/**
 * Read users and custom attribute categories with one exact-scope token per capability.
 * Every Google call is a direct read or a batch part of A section 6.
 */
export class GoogleUserReader {
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly backoff: (attempt: number) => number;
  private readonly batch: GoogleBatchService;

  constructor(options: GoogleUserReaderOptions = {}) {
    this.sleep = options.sleep ?? quotaSleep;
    this.backoff = options.backoff ?? quotaBackoff;
    this.batch = options.batch ?? new GoogleBatchService();
  }

  /** Follow page tokens. A quota answer retries the same page up to 25 times, then fails with quota. */
  private async *pages<T>(
    credential: DelegatedCredential,
    scope: string,
    signal: AbortSignal,
    limit: number | undefined,
    load: (
      client: OAuth2Client,
      pageToken: string | undefined,
    ) => Promise<{
      items: T[];
      nextPageToken: string | undefined;
    }>,
  ): AsyncGenerator<T[]> {
    let client = await scopedClient(credential, scope, signal, limit);
    let issuedAt = Date.now();
    let pageToken: string | undefined;
    for (let page = 0; page < maximumPages; page++) {
      let result;
      for (let attempt = 0; ; attempt++) {
        if (Date.now() - issuedAt > tokenRenewalMilliseconds) {
          client = await scopedClient(credential, scope, signal, limit);
          issuedAt = Date.now();
        }
        try {
          result = await load(client, pageToken);
          break;
        } catch (error) {
          const classified = failure(error);
          if (
            classified.code !== 'quota' ||
            attempt >= BATCH_DEFAULTS.maxQuotaRetries
          )
            throw classified;
          await this.sleep(this.backoff(attempt), signal);
          if (signal.aborted) throw new GoogleConnectionError('quota');
        }
      }
      yield result.items;
      if (!result.nextPageToken) return;
      pageToken = result.nextPageToken;
    }
    throw new GoogleConnectionError('invalid-response');
  }

  /**
   * Read every user of the customer with `projection=full`, 500 users a page (A section 6).
   * The pager stops after 10,000 pages.
   */
  userPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<UserObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    return this.pages(
      credential,
      scopeFor('user-inventory'),
      signal,
      userPageLimit,
      async (client, pageToken) => {
        const data = userPage.parse(
          (
            await client.request({
              url: `${directory}/users`,
              method: 'GET',
              params: {
                customer: customerId,
                projection: 'full',
                maxResults: 500,
                fields: userListFields,
                ...(pageToken ? { pageToken } : {}),
              },
            })
          ).data,
        );
        return {
          items: (data.users ?? []).map(userObservation),
          nextPageToken: data.nextPageToken,
        };
      },
    );
  }

  /**
   * One `users.get` part per user through the batch service, with `projection=full`
   * (A section 6). A 404 names a removed user. Quota and server errors retry per part.
   * `onRound` runs after each multipart round, so the caller can extend its claim.
   */
  async users(
    credential: DelegatedCredential,
    customerId: string,
    userIds: readonly string[],
    signal: AbortSignal,
    onRound?: () => Promise<void>,
  ): Promise<{ users: UserObservation[]; missing: string[] }> {
    googleCustomerIdSchema.parse(customerId);
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return { users: [], missing: [] };
    if (ids.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    let result;
    try {
      result = await this.batch.execute({
        batchUrl: batchEndpoint,
        requests: ids.map((id) => ({
          id,
          method: 'GET' as const,
          path: `${directoryPath}/users/${encodeURIComponent(id)}`,
          query: { projection: 'full', fields: userFields },
        })),
        parse: (body) => userObservation(userResource.parse(body)),
        options: { batchSize: userReadBatchSize },
        getClient: async (runSignal) => {
          try {
            return await scopedClient(
              credential,
              scopeFor('user-inventory'),
              runSignal,
              batchResponseLimit,
            );
          } catch (error) {
            mint.failure = failure(error, 'token');
            throw mint.failure;
          }
        },
        signal,
        ...(onRound ? { onBatch: onRound } : {}),
      });
    } catch (error) {
      if (error instanceof BatchServiceError)
        throw new GoogleConnectionError(
          error.code === 'malformed-response'
            ? 'invalid-response'
            : 'request-failed',
        );
      throw error;
    }
    if (mint.failure) throw mint.failure;
    const users: UserObservation[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const pages = result.succeeded.get(id);
      if (pages) {
        users.push(...pages);
        continue;
      }
      const failed = result.failed.get(id);
      if (failed?.kind === 'not-found') missing.push(id);
      else if (failed) throw batchFailure(failed);
    }
    return { users, missing };
  }

  /**
   * Read every custom attribute category in one direct GET (B section 9).
   * The read carries the 25-second deadline of that section.
   */
  async categories(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    signal = AbortSignal.any([
      signal,
      AbortSignal.timeout(categoryDeadlineMilliseconds),
    ]);
    const client = await scopedClient(
      credential,
      scopeFor('user-schemas'),
      signal,
      userPageLimit,
    );
    try {
      const data = categoryPage.parse(
        (
          await client.request({
            url: `${directory}/customer/${customerId}/schemas`,
            method: 'GET',
            params: { fields: categoryFields },
          })
        ).data,
      );
      return (data.schemas ?? []).map(categoryObservation);
    } catch (error) {
      throw failure(error, 'read');
    }
  }

  /**
   * One `schemas.get` part. The `schemaId` stays opaque, so it travels as one
   * percent-encoded path segment (C8). A 404 returns null; quota retries the part.
   */
  async category(
    credential: DelegatedCredential,
    customerId: string,
    schemaId: string,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation | null> {
    googleCustomerIdSchema.parse(customerId);
    const id = 'schema';
    const mint: { failure?: GoogleConnectionError } = {};
    let result: BatchResult<UserAttributeCategoryObservation>;
    try {
      result = await this.batch.execute({
        batchUrl: batchEndpoint,
        requests: [
          {
            id,
            method: 'GET' as const,
            path: `${directoryPath}/customer/${customerId}/schemas/${encodeURIComponent(schemaId)}`,
          },
        ],
        parse: (body) => categoryObservation(categoryResource.parse(body)),
        getClient: async (runSignal) => {
          try {
            return await scopedClient(
              credential,
              scopeFor('user-schemas'),
              runSignal,
              batchResponseLimit,
            );
          } catch (error) {
            mint.failure = failure(error, 'token');
            throw mint.failure;
          }
        },
        signal,
      });
    } catch (error) {
      if (error instanceof BatchServiceError)
        throw new GoogleConnectionError(
          error.code === 'malformed-response'
            ? 'invalid-response'
            : 'request-failed',
        );
      throw error;
    }
    if (mint.failure && !signal.aborted) throw mint.failure;
    const pages = result.succeeded.get(id);
    if (pages) return pages[pages.length - 1];
    const failed = result.failed.get(id);
    if (failed?.kind === 'not-found') return null;
    if (failed) throw batchFailure(failed);
    throw new GoogleConnectionError('invalid-response');
  }
}

/** One attribute of a category write body (B section 6.1). */
export interface CategoryWriteField {
  /** The Google field ID of a kept attribute. A new attribute carries none. */
  fieldId?: string;
  fieldName: string;
  displayName: string;
  fieldType: UserAttributeFieldType;
  multiValued?: boolean;
  indexed?: boolean;
  readAccessType?: UserAttributeVisibility;
  numericIndexingSpec?: {
    minValue: number | null;
    maxValue: number | null;
  } | null;
}

/** The complete category body that an insert or an update sends (B section 6.1). */
export interface CategoryWriteBody {
  schemaName: string;
  displayName: string;
  fields: readonly CategoryWriteField[];
}

const categoryWriteField = z.strictObject({
  fieldId: z.string().min(1).max(200).optional(),
  fieldName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  fieldType: userAttributeFieldTypeSchema,
  multiValued: z.boolean().optional(),
  indexed: z.boolean().optional(),
  readAccessType: userAttributeVisibilitySchema.optional(),
  numericIndexingSpec: z
    .strictObject({
      minValue: z.number().nullable(),
      maxValue: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

/** The body that a category write may hold. No other property leaves the process. */
export const categoryWriteBodySchema = z.strictObject({
  schemaName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  fields: z.array(categoryWriteField).min(1).max(USER_ATTRIBUTE_FIELD_LIMIT),
});

/** The etag that an update or a delete carries in `If-Match` (E7, C7). */
const categoryEtag = z.string().min(1).max(1024);

/**
 * The part ID of every category call. One operation is one part, so every
 * category call holds this one ID (B section 7.1).
 */
export const CATEGORY_PART_ID = 'category';

/**
 * The last gate of a category write: the worker checks ownership and cancellation here, after the
 * token mint and immediately before the multipart request. `false` sends nothing (design card K16,
 * R4).
 */
export type CategorySendGate = () => Promise<boolean>;

/**
 * The send gate refused the request, so the part never left the worker. The caller settles or
 * answers with its own fence; this error never means a Google condition.
 */
export class CategorySendRefused extends Error {
  constructor() {
    super('category-send-refused');
    this.name = 'CategorySendRefused';
  }
}

export interface GoogleCategoryWriterOptions {
  batch?: GoogleBatchService;
  /** A reader that serves the `schemas.get` part. */
  reader?: Pick<GoogleUserReader, 'category'>;
}

/**
 * Write custom attribute categories with one exact-scope token per call.
 * A read carries the read-only schema scope; an insert, an update, and a delete
 * carry the schema write scope (design section 4). An update and a delete send
 * the plan etag in `If-Match` (E7, C7). A transient answer never repeats an
 * insert, because a second POST may create a second category (B section 7.3).
 */
export class GoogleCategoryWriter {
  private readonly batch: GoogleBatchService;
  private readonly reader: Pick<GoogleUserReader, 'category'>;

  constructor(options: GoogleCategoryWriterOptions = {}) {
    this.batch = options.batch ?? new GoogleBatchService();
    this.reader = options.reader ?? new GoogleUserReader({ batch: this.batch });
  }

  /** One `schemas.get` part with the read-only schema scope (C8). */
  category(
    credential: DelegatedCredential,
    customerId: string,
    schemaId: string,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation | null> {
    return this.reader.category(credential, customerId, schemaId, signal);
  }

  /**
   * One `schemas.insert` POST part with the write scope and no `If-Match` (C6). The gate runs
   * after the token mint and immediately before the request; a refusal throws
   * `CategorySendRefused` and sends no part (R4).
   */
  async insertCategory(
    credential: DelegatedCredential,
    customerId: string,
    body: CategoryWriteBody,
    signal: AbortSignal,
    beforeSend?: CategorySendGate,
  ): Promise<BatchResult<UserAttributeCategoryObservation>> {
    googleCustomerIdSchema.parse(customerId);
    return this.call(
      credential,
      customerId,
      {
        id: CATEGORY_PART_ID,
        method: 'POST',
        path: `${directoryPath}/customer/${customerId}/schemas`,
        body: categoryWriteBodySchema.parse(body),
      },
      categoryAnswer,
      signal,
      beforeSend,
    );
  }

  /**
   * One `schemas.update` PUT part with the complete schema and the plan etag
   * in `If-Match` (B section 6.1, E7). The gate runs after the token mint and immediately before
   * the request (R4).
   */
  async updateCategory(
    credential: DelegatedCredential,
    customerId: string,
    schemaId: string,
    etag: string,
    body: CategoryWriteBody,
    signal: AbortSignal,
    beforeSend?: CategorySendGate,
  ): Promise<BatchResult<UserAttributeCategoryObservation>> {
    googleCustomerIdSchema.parse(customerId);
    return this.call(
      credential,
      customerId,
      {
        id: CATEGORY_PART_ID,
        method: 'PUT',
        path: `${directoryPath}/customer/${customerId}/schemas/${encodeURIComponent(schemaId)}`,
        headers: { 'If-Match': categoryEtag.parse(etag) },
        body: categoryWriteBodySchema.parse(body),
      },
      categoryAnswer,
      signal,
      beforeSend,
    );
  }

  /**
   * One `schemas.delete` DELETE part with the plan etag in `If-Match` (E7).
   * Google answers 204, so a succeeded part holds no value. The gate runs after the token mint
   * and immediately before the request (R4).
   */
  async deleteCategory(
    credential: DelegatedCredential,
    customerId: string,
    schemaId: string,
    etag: string,
    signal: AbortSignal,
    beforeSend?: CategorySendGate,
  ): Promise<BatchResult<null>> {
    googleCustomerIdSchema.parse(customerId);
    return this.call(
      credential,
      customerId,
      {
        id: CATEGORY_PART_ID,
        method: 'DELETE',
        path: `${directoryPath}/customer/${customerId}/schemas/${encodeURIComponent(schemaId)}`,
        headers: { 'If-Match': categoryEtag.parse(etag) },
      },
      () => null,
      signal,
      beforeSend,
    );
  }

  /**
   * Send one part with a write-scope token and keep every part answer.
   * A caller classifies `failed`: C6 and C7 settle 409 or 412, and an
   * unanswered insert stays Unknown (B section 7.3).
   * `beforeSend` runs inside the batch, after it mints the write token and immediately before the
   * multipart request. A false answer throws `CategorySendRefused`, so no request leaves (R4).
   */
  private async call<T>(
    credential: DelegatedCredential,
    customerId: string,
    request: BatchRequest,
    parse: (body: unknown) => T,
    signal: AbortSignal,
    beforeSend?: CategorySendGate,
  ): Promise<BatchResult<T>> {
    const mint: { failure?: GoogleConnectionError } = {};
    let result: BatchResult<T>;
    try {
      result = await this.batch.execute<T>({
        batchUrl: batchEndpoint,
        requests: [request],
        parse,
        getClient: async (runSignal) => {
          try {
            return await scopedClient(
              credential,
              scopeFor('user-schema-changes'),
              runSignal,
              batchResponseLimit,
            );
          } catch (error) {
            mint.failure = failure(error, 'token');
            throw mint.failure;
          }
        },
        signal,
        ...(beforeSend === undefined
          ? {}
          : {
              onSend: async () => {
                if (!(await beforeSend())) throw new CategorySendRefused();
              },
            }),
      });
    } catch (error) {
      if (error instanceof BatchServiceError)
        throw new GoogleConnectionError(
          error.code === 'malformed-response'
            ? 'invalid-response'
            : 'request-failed',
        );
      throw error;
    }
    if (mint.failure && !signal.aborted) throw mint.failure;
    return result;
  }
}

/** Map one category answer of an insert or an update. */
function categoryAnswer(body: unknown): UserAttributeCategoryObservation {
  return categoryObservation(categoryResource.parse(body));
}
