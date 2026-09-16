import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  googleCandidateSchema,
  googleConnectionSchema,
  googleCredentialImportSchema,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  CredentialCipher,
  CredentialError,
  GoogleConnectionError,
  GoogleCustomerVerifier,
  GoogleConnectionProvider,
  GoogleStoreError,
  validateServiceAccount,
} from '@campus/google-connection';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class GoogleConnectionService
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private cleaning = false;
  private readonly verifier = new GoogleCustomerVerifier();

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
  ) {}

  onModuleInit() {
    if (this.configuration.deployment?.phase !== 3) return;
    this.timer = setInterval(() => void this.cleanup(), 60_000);
    this.timer.unref();
    void this.cleanup();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      await this.database.connection.query(
        'SELECT cc.expire_google_candidates($1)',
        [randomUUID()],
      );
    } catch {
      /* A later bounded pass retries cleanup. Reads still enforce expiry. */
    } finally {
      this.cleaning = false;
    }
  }

  private cipher() {
    const config = this.configuration.deployment?.googleConnection;
    if (!config)
      throw new ServiceUnavailableException({
        reason: 'connection-not-configured',
      });
    let key: Buffer | undefined;
    try {
      key = this.configuration.secret(config.encryptionKeySecretRef);
      return new CredentialCipher(config.keyId, key);
    } catch {
      throw new ServiceUnavailableException({
        reason: 'connection-key-unavailable',
      });
    } finally {
      key?.fill(0);
    }
  }

  private actor(session: SessionResponse) {
    if (this.configuration.deployment?.phase !== 3)
      throw new ServiceUnavailableException({
        reason: 'connection-not-configured',
      });
    return [session.identity.id, session.identity.permissionVersion];
  }

  private candidateActor(session: SessionResponse, id: string) {
    return [
      ...this.actor(session),
      id,
      createHash('sha256').update(session.csrfToken).digest('hex'),
    ];
  }

  private async query(sql: string, values: unknown[]) {
    try {
      return (await this.database.connection.query(sql, values)).rows[0]?.[
        'result'
      ];
    } catch (error) {
      const parsed = z
        .object({ code: z.string(), detail: z.string().optional() })
        .safeParse(error);
      if (parsed.success && parsed.data.code === '42501')
        throw new ForbiddenException({ reason: 'forbidden' });
      if (parsed.success && parsed.data.code === 'P0001') {
        const reason = parsed.data.detail;
        if (reason === 'busy') throw new HttpException({ reason: 'busy' }, 429);
        throw new ConflictException({
          reason: ['already-connected', 'credential-changed'].includes(
            reason ?? '',
          )
            ? reason
            : 'candidate-changed',
        });
      }
      throw new ServiceUnavailableException({
        reason: 'connection-store-unavailable',
      });
    }
  }

  private publicCandidate(value: unknown) {
    const data = z.record(z.string(), z.unknown()).parse(value);
    const { envelope: _envelope, ...metadata } = data;
    return googleCandidateSchema.parse(metadata);
  }

  async read(session: SessionResponse) {
    return googleConnectionSchema
      .nullable()
      .parse(
        await this.query(
          'SELECT cc.read_google_connection($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async check(
    session: SessionResponse,
    customerId: string,
    generation: number,
    retry: boolean,
    correlationId: string,
  ) {
    if (retry)
      await this.query('SELECT cc.reset_google_access($1,$2,$3,$4,$5)', [
        ...this.actor(session),
        customerId,
        generation,
        correlationId,
      ]);
    try {
      return await new GoogleConnectionProvider(
        this.database.connection,
        this.cipher(),
      ).read({ customerId, generation, correlationId });
    } catch (error) {
      if (
        error instanceof GoogleStoreError &&
        error.code === 'credential-changed'
      )
        throw new ConflictException({ reason: error.code });
      if (
        error instanceof GoogleConnectionError ||
        error instanceof GoogleStoreError ||
        error instanceof CredentialError
      )
        throw new ServiceUnavailableException({ reason: error.code });
      throw error;
    }
  }

  async candidate(session: SessionResponse, id: string) {
    return this.publicCandidate(
      await this.query(
        'SELECT cc.read_google_candidate($1,$2,$3,$4) AS result',
        this.candidateActor(session, id),
      ),
    );
  }

  async stage(
    session: SessionResponse,
    input: z.infer<typeof googleCredentialImportSchema>,
    correlation: string,
  ) {
    const cipher = this.cipher();
    let credential;
    try {
      credential = {
        serviceAccount: validateServiceAccount(
          input.serviceAccount,
          input.clientId,
        ),
        subject: input.subject,
      };
    } catch (error) {
      if (error instanceof CredentialError)
        throw new HttpException(
          { reason: 'invalid-service-account-file' },
          400,
        );
      throw error;
    }
    const id = input.id;
    const actor = this.candidateActor(session, id);
    const envelope = cipher.seal(credential, {
      recordId: id,
      customerId: null,
      generation: 0,
    });
    await this.query(
      'SELECT cc.stage_google_credential($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        ...actor,
        input.clientId,
        input.subject,
        JSON.stringify(envelope),
        correlation,
      ],
    );
    let observation = null;
    let failure = null;
    try {
      observation = await this.verifier.verify(credential);
    } catch (error) {
      failure =
        error instanceof GoogleConnectionError ? error.code : 'request-failed';
    }
    await this.query(
      'SELECT cc.finish_google_candidate($1,$2,$3,$4,$5,$6,$7)',
      [
        ...actor,
        observation && JSON.stringify(observation),
        failure,
        correlation,
      ],
    );
    return this.candidate(session, id);
  }

  async confirm(
    session: SessionResponse,
    id: string,
    customerId: string,
    correlation: string,
  ) {
    const actor = this.candidateActor(session, id);
    const stored = z
      .object({ envelope: z.unknown() })
      .passthrough()
      .parse(
        await this.query(
          'SELECT cc.read_google_candidate($1,$2,$3,$4) AS result',
          actor,
        ),
      );
    const candidate = this.publicCandidate(stored);
    if (
      candidate.status !== 'ready' ||
      candidate.observation?.customerId !== customerId
    )
      throw new ConflictException({ reason: 'candidate-changed' });
    const cipher = this.cipher();
    try {
      const credential = cipher.open(stored.envelope, {
        recordId: id,
        customerId: null,
        generation: 0,
      });
      const envelope = cipher.seal(credential, {
        recordId: id,
        customerId,
        generation: 1,
      });
      return await this.query(
        'SELECT cc.confirm_google_customer($1,$2,$3,$4,$5,$6,$7) AS result',
        [...actor, customerId, JSON.stringify(envelope), correlation],
      );
    } catch (error) {
      if (error instanceof CredentialError)
        throw new ServiceUnavailableException({
          reason: 'credential-unavailable',
        });
      throw error;
    }
  }
}
