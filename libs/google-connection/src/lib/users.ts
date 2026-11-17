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
  type UserObservation,
} from '@campus/application-contracts';
import type { DelegatedCredential } from './credential';
import {
  BATCH_DEFAULTS,
  BatchServiceError,
  GoogleBatchService,
  type BatchFailure,
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

function scopeFor(id: 'user-inventory' | 'user-schemas'): string {
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
