import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  googleDriveAccessSchema,
  googleDriveCauseSchema,
  googleDriveFileIdSchema,
  googleDriveSessionSchema,
  googleDriveTabListSchema,
  type GoogleDriveAccess,
  type GoogleDriveCause,
  type GoogleDriveSession,
  type GoogleDriveTabList,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  GoogleConnectionError,
  GoogleDriveError,
  personDriveClient,
  personDriveToken,
  type GoogleDriveClient,
  type GoogleDriveToken,
} from '@campus/google-connection';
import { AuthService } from '../auth/auth.service';
import {
  GoogleConnectionService,
  type GoogleDriveAccessFacts,
} from '../auth/google-connection.service';
import { CacheService } from '../cache/cache.service';
import { DEVICE_IMPORT_ACTIONS } from '../devices/device-imports';
import { DevicesService } from '../devices/devices.service';
import { requireDeviceActions } from '../devices/device-updates-actions';

/**
 * The Drive access, session, and tab list of the devices dialog
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, sections 1, 4, and 5).
 *
 * The access read combines three stored facts: the settings row, the last `drive-files` result,
 * and the session. It calls no Google API. The session route mints one `drive.file` token for the
 * session subject and keeps no copy. The tab list reads one Sheet as the same person. The session
 * cause stays in the session cache; no answer, log, or cache entry holds a token.
 */

/** The two `drive-files` results that name a delegation refusal (design section 1). */
const DELEGATION_FAILURES = new Set<string>([
  'delegation-not-authorized',
  'scope-mismatch',
]);

/** The cached session cause. It holds no token and no subject. */
const driveCauseEntrySchema = z.strictObject({
  cause: googleDriveCauseSchema,
});

/** The Google exchange and Drive read deadline of one route. */
const GOOGLE_TIMEOUT_MILLISECONDS = 30_000;

@Injectable()
export class DriveService {
  constructor(
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly connection: GoogleConnectionService,
    private readonly cache: CacheService,
  ) {}

  /**
   * The access answer of the devices dialog (design section 1). The SQL function checks
   * `devices:read`. Ruling 6 keeps the cause note readable to every person that reads devices.
   */
  async access(
    session: SessionResponse,
    cookie: string | undefined,
  ): Promise<GoogleDriveAccess> {
    const facts = await this.connection.driveAccess(session);
    const cause = await this.sessionCause(session);
    const subject = await this.auth.driveSubject(cookie);
    const sheetExport = this.sheetExportCause(facts, cause, subject);
    const driveImport = this.driveImportCause(facts, cause, subject);
    return googleDriveAccessSchema.parse({
      sheetExport:
        sheetExport === null
          ? { available: true }
          : { available: false, cause: sheetExport },
      driveImport:
        driveImport === null
          ? { available: true }
          : { available: false, cause: driveImport },
    });
  }

  /**
   * Mint the one-hour `drive.file` token of the session subject (design section 4). A refused
   * exchange marks the session, so later access reads answer the same cause until the next sign-in.
   * The answer carries the token once and stores no copy of it.
   */
  async session(
    session: SessionResponse,
    cookie: string | undefined,
    correlationId: string,
  ): Promise<GoogleDriveSession> {
    const current = await this.current(session, correlationId);
    const facts = await this.connection.driveAccess(session);
    if (!facts?.settings) throw this.unavailable('setup');
    const subject = await this.auth.driveSubject(cookie);
    if (subject === null) {
      await this.markCause(session, 'account');
      throw this.unavailable('account');
    }
    const credential = await this.connection.driveCredential(
      session,
      current.customerId,
      current.generation,
    );
    let token: GoogleDriveToken;
    try {
      token = await personDriveToken(
        credential,
        subject,
        AbortSignal.timeout(GOOGLE_TIMEOUT_MILLISECONDS),
      );
    } catch (error) {
      await this.refuse(session, error);
      throw error;
    }
    await this.clearCause(session);
    return googleDriveSessionSchema.parse({
      accessToken: token.accessToken,
      expiresAt: new Date(token.expiresAt).toISOString(),
      apiKey: facts.settings.pickerApiKey,
      appId: facts.settings.projectNumber,
    });
  }

  /**
   * List the tabs of one Sheet as the session subject (design section 1). A malformed file ID is a
   * missing Drive file. The route mints a token for this read and stores no copy of it.
   */
  async tabs(
    session: SessionResponse,
    cookie: string | undefined,
    fileId: string,
    correlationId: string,
  ): Promise<GoogleDriveTabList> {
    const id = googleDriveFileIdSchema.safeParse(fileId);
    if (!id.success)
      throw new NotFoundException({ reason: 'drive-file-unavailable' });
    const current = await this.current(session, correlationId);
    const cause = await this.sessionCause(session);
    if (cause !== null) throw this.unavailable(cause);
    const subject = await this.auth.driveSubject(cookie);
    if (subject === null) {
      await this.markCause(session, 'account');
      throw this.unavailable('account');
    }
    const credential = await this.connection.driveCredential(
      session,
      current.customerId,
      current.generation,
    );
    let client: GoogleDriveClient;
    try {
      client = await personDriveClient(
        credential,
        subject,
        AbortSignal.timeout(GOOGLE_TIMEOUT_MILLISECONDS),
      );
    } catch (error) {
      await this.refuse(session, error);
      throw error;
    }
    try {
      return googleDriveTabListSchema.parse(await client.tabs(id.data));
    } catch (error) {
      if (error instanceof GoogleDriveError) {
        if (error.code === 'drive-file-unavailable')
          throw new NotFoundException({ reason: 'drive-file-unavailable' });
        if (error.code === 'not-a-sheet')
          throw new UnprocessableEntityException({ reason: 'not-a-sheet' });
      }
      await this.refuse(session, error);
      throw error;
    }
  }

  /**
   * Resolve the connected customer, then run the import permission checks in order (record:109-115).
   * A missing connection leaves nothing to exchange.
   */
  private async current(session: SessionResponse, correlationId: string) {
    const current = await this.devices.sync(session);
    if (!current) throw this.unavailable('setup');
    await requireDeviceActions(
      this.auth,
      session,
      current.customerId,
      correlationId,
      DEVICE_IMPORT_ACTIONS,
    );
    return current;
  }

  /** The Sheet export cause: `setup` never applies, because an export opens no Picker. */
  private sheetExportCause(
    facts: GoogleDriveAccessFacts,
    cause: GoogleDriveCause | null,
    subject: string | null,
  ): GoogleDriveCause | null {
    if (cause !== null) return cause;
    if (facts === null) return 'delegation';
    if (subject === null) return 'account';
    return this.delegationFailure(facts) ? 'delegation' : null;
  }

  /**
   * The Drive import cause: the Picker settings come first, because the Picker cannot open without
   * the key. The stored session cause follows, then the verified subject and the health result.
   */
  private driveImportCause(
    facts: GoogleDriveAccessFacts,
    cause: GoogleDriveCause | null,
    subject: string | null,
  ): GoogleDriveCause | null {
    if (facts === null || facts.settings === null) return 'setup';
    if (cause !== null) return cause;
    if (subject === null) return 'account';
    return this.delegationFailure(facts) ? 'delegation' : null;
  }

  private delegationFailure(facts: GoogleDriveAccessFacts): boolean {
    const failure = facts?.driveFiles?.failure;
    return failure !== null && failure !== undefined
      ? DELEGATION_FAILURES.has(failure)
      : false;
  }

  /** A refused exchange marks the session for delegation or account refusals only. */
  private async refuse(
    session: SessionResponse,
    error: unknown,
  ): Promise<never> {
    if (error instanceof GoogleConnectionError) {
      const cause: GoogleDriveCause | null =
        error.code === 'delegation-not-authorized' ||
        error.code === 'scope-mismatch'
          ? 'delegation'
          : error.code === 'credential-rejected'
            ? 'account'
            : null;
      if (cause !== null) {
        await this.markCause(session, cause);
        throw this.unavailable(cause);
      }
    }
    throw new ServiceUnavailableException({ reason: 'google-unavailable' });
  }

  /** The one refusal body of the token routes. */
  private unavailable(cause: GoogleDriveCause): ConflictException {
    return new ConflictException({ reason: 'drive-unavailable', cause });
  }

  /** The cache key of the session cause. A new sign-in makes a new CSRF token and a new key. */
  private causeKey(session: SessionResponse): string {
    return `cc:drive-cause:${createHash('sha256')
      .update(session.csrfToken)
      .digest('hex')}`;
  }

  private async sessionCause(
    session: SessionResponse,
  ): Promise<GoogleDriveCause | null> {
    const raw = await this.cache.get(this.causeKey(session));
    if (raw === null) return null;
    try {
      const parsed = driveCauseEntrySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.cause : null;
    } catch {
      return null;
    }
  }

  /** Store the cause until the session expires. A cause entry holds no token and no subject. */
  private async markCause(
    session: SessionResponse,
    cause: GoogleDriveCause,
  ): Promise<void> {
    const seconds = Math.floor(
      (Date.parse(session.expiresAt) - Date.now()) / 1000,
    );
    if (seconds <= 0) return;
    await this.cache.set(
      this.causeKey(session),
      JSON.stringify({ cause }),
      seconds,
    );
  }

  /** A later successful exchange proves access, so the stored cause no longer applies. */
  private async clearCause(session: SessionResponse): Promise<void> {
    await this.cache.remove(this.causeKey(session));
  }
}
