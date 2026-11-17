import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  USER_ATTRIBUTE_CATEGORY_LIMIT,
  USER_ATTRIBUTE_FIELD_LIMIT,
  userAttributeCategoriesSchema,
  type SessionResponse,
  type UserAttributeCategories,
  type UserAttributeCategoryObservation,
} from '@campus/application-contracts';
import { failure, type DelegatedCredential } from '@campus/google-connection';

/** The cache rule of B section 9: a category read stays current for 24 hours. */
export const USER_CATEGORY_CACHE_MILLISECONDS = 24 * 60 * 60 * 1000;
/** The Google read deadline of B section 9. The reader applies it again to its own call. */
export const USER_CATEGORY_DEADLINE_MILLISECONDS = 25_000;

/** The connection, the cache, the credential, and the Google read of one category read. */
export interface UserCategoryPort {
  /** The connected customer from cc.user_reader. Null means no connection. */
  connection(
    session: SessionResponse,
  ): Promise<{ customerId: string; generation: number } | null>;
  /** The cached set. Null means no connection. It carries no category before the first read. */
  cached(session: SessionResponse): Promise<UserAttributeCategories | null>;
  /** Open the active credential of this generation. Null means no connection. */
  credential(
    session: SessionResponse,
    customerId: string,
    generation: number,
  ): Promise<DelegatedCredential | null>;
  /** Read schemas.list with the category read scope (B section 9). */
  read(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): Promise<UserAttributeCategoryObservation[]>;
  /** Replace the whole cached set and answer it with its holder counts. */
  store(
    session: SessionResponse,
    customerId: string,
    categories: UserAttributeCategoryObservation[],
    readAt: string,
  ): Promise<UserAttributeCategories>;
}

export interface UserCategoryOptions {
  /** The clock of the cache rule. The tests pass their own. */
  now?(): number;
  deadlineMilliseconds?: number;
}

/** The empty read of a customer without a category. */
export function emptyUserAttributeCategories(): UserAttributeCategories {
  return {
    categories: [],
    limits: {
      categories: 0,
      categoryLimit: USER_ATTRIBUTE_CATEGORY_LIMIT,
      attributes: 0,
      attributeLimit: USER_ATTRIBUTE_FIELD_LIMIT,
    },
    observedAt: null,
  };
}

/**
 * The category read of B section 10 row 1, by the cache rules of B section 9.
 * The tab read uses the cache while it is younger than 24 hours, and Refresh reads Google at once.
 */
export class UserAttributeCategoriesRoute {
  private readonly port: UserCategoryPort;
  private readonly now: () => number;
  private readonly deadlineMilliseconds: number;

  constructor(port: UserCategoryPort, options: UserCategoryOptions = {}) {
    this.port = port;
    this.now = options.now ?? Date.now;
    this.deadlineMilliseconds =
      options.deadlineMilliseconds ?? USER_CATEGORY_DEADLINE_MILLISECONDS;
  }

  private readFailure(error: unknown) {
    return new ServiceUnavailableException({
      reason: 'user-schema-read-failed',
      failure: failure(error, 'read').code,
    });
  }

  /** Read Google now, store the whole set, and answer it. */
  async refresh(session: SessionResponse): Promise<UserAttributeCategories> {
    const connection = await this.port.connection(session);
    if (!connection)
      throw new ConflictException({ reason: 'connection-required' });
    const deadline = this.now() + this.deadlineMilliseconds;
    const remaining = deadline - this.now();
    if (remaining <= 0) throw this.readFailure(new Error('deadline'));
    let categories: UserAttributeCategoryObservation[];
    try {
      const credential = await this.port.credential(
        session,
        connection.customerId,
        connection.generation,
      );
      if (!credential)
        throw new ConflictException({ reason: 'connection-required' });
      categories = await this.port.read(
        credential,
        connection.customerId,
        AbortSignal.timeout(remaining),
      );
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw this.readFailure(error);
    }
    return userAttributeCategoriesSchema.parse(
      await this.port.store(
        session,
        connection.customerId,
        categories,
        new Date(this.now()).toISOString(),
      ),
    );
  }

  /**
   * Read the categories of the tab. A cache younger than 24 hours answers alone. A stale cache
   * tries the Google read, and it stands when that read fails. No cache and a failed read answer
   * the failure, so the client names the missing scope.
   */
  async read(session: SessionResponse): Promise<UserAttributeCategories> {
    const cached = await this.port.cached(session);
    if (!cached) return emptyUserAttributeCategories();
    const observedAt = cached.observedAt ? Date.parse(cached.observedAt) : NaN;
    if (
      Number.isFinite(observedAt) &&
      this.now() - observedAt < USER_CATEGORY_CACHE_MILLISECONDS
    )
      return cached;
    try {
      return await this.refresh(session);
    } catch (error) {
      if (cached.categories.length) return cached;
      throw error;
    }
  }
}
