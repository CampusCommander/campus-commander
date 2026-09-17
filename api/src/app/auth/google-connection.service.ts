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
  googleCredentialManagementSchema,
  googleCredentialReplacementSchema,
  googleCredentialActivationSchema,
  googleReplacementActivationSchema,
  googleKeyRotationSchema,
  googleHealthSchema,
  googleHealthCheckSchema,
  googleCapabilityResultSchema,
  googleFailureSchema,
  schoolReferenceRefreshSchema,
  schoolReferenceStateSchema,
  type SchoolReferenceObservation,
  type GoogleHealthCapability,
  type GoogleCapabilityResult,
  type GoogleObservation,
  googleConnectionSchema,
  googleCredentialImportSchema,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  loadCredentialCipher,
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
    try {
      return loadCredentialCipher(config, (reference) =>
        this.configuration.secret(reference),
      );
    } catch {
      throw new ServiceUnavailableException({
        reason: 'connection-key-unavailable',
      });
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
      if (
        parsed.success &&
        parsed.data.code === 'P0001' &&
        [
          'health-check-running',
          'health-rate-limited',
          'reference-check-running',
          'reference-rate-limited',
        ].includes(parsed.data.detail ?? '')
      ) {
        throw new HttpException({ reason: parsed.data.detail }, 429);
      }
      if (parsed.success && parsed.data.code === 'P0001') {
        const reason = parsed.data.detail;
        if (reason === 'busy') throw new HttpException({ reason: 'busy' }, 429);
        throw new ConflictException({
          reason: [
            'already-connected',
            'credential-changed',
            'connection-disconnected',
            'health-check-changed',
            'reference-check-changed',
          ].includes(reason ?? '')
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

  async health(session: SessionResponse) {
    return googleHealthSchema
      .nullable()
      .parse(
        await this.query(
          'SELECT cc.read_google_health($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async schoolReferences(session: SessionResponse) {
    return schoolReferenceStateSchema
      .nullable()
      .parse(
        await this.query(
          'SELECT cc.read_school_references($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async refreshSchoolReferences(
    session: SessionResponse,
    input: z.infer<typeof schoolReferenceRefreshSchema>,
    correlationId: string,
  ) {
    const claim = z
      .strictObject({
        id: z.uuid(),
        credentialId: z.uuid(),
        envelope: z.unknown(),
      })
      .parse(
        await this.query(
          'SELECT cc.claim_school_references($1,$2,$3,$4,$5,$6) AS result',
          [
            ...this.actor(session),
            input.customerId,
            input.generation,
            randomUUID(),
            correlationId,
          ],
        ),
      );
    let observation: SchoolReferenceObservation | null = null;
    let failure: z.infer<typeof schoolReferenceStateSchema>['failure'] = null;
    try {
      const credential = this.cipher().open(claim.envelope, {
        recordId: claim.credentialId,
        customerId: input.customerId,
        generation: input.generation,
      });
      observation = await this.verifier.readSchoolReferences(
        credential,
        input.customerId,
        input.generation,
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      failure =
        error instanceof GoogleConnectionError
          ? googleFailureSchema.parse(error.code)
          : error instanceof CredentialError ||
              error instanceof ServiceUnavailableException
            ? 'key-unavailable'
            : 'request-failed';
    }
    return schoolReferenceStateSchema.parse(
      await this.query(
        'SELECT cc.finish_school_references($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          ...this.actor(session),
          input.customerId,
          input.generation,
          claim.id,
          observation === null ? null : JSON.stringify(observation),
          failure,
        ],
      ),
    );
  }

  private async claimHealth(
    session: SessionResponse,
    customerId: string,
    generation: number,
    capabilities: GoogleHealthCapability[],
    correlationId: string,
  ) {
    return z
      .strictObject({
        id: z.uuid(),
        credentialId: z.uuid(),
        envelope: z.unknown(),
      })
      .parse(
        await this.query(
          'SELECT cc.claim_google_health($1,$2,$3,$4,$5,$6,$7) AS result',
          [
            ...this.actor(session),
            customerId,
            generation,
            randomUUID(),
            JSON.stringify(capabilities),
            correlationId,
          ],
        ),
      );
  }

  private async finishHealth(
    session: SessionResponse,
    customerId: string,
    generation: number,
    id: string,
    results: GoogleCapabilityResult[],
    observation: GoogleObservation | null,
  ) {
    return googleHealthSchema.parse(
      await this.query(
        'SELECT cc.finish_google_health($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          ...this.actor(session),
          customerId,
          generation,
          id,
          JSON.stringify(z.array(googleCapabilityResultSchema).parse(results)),
          observation ? JSON.stringify(observation) : null,
        ],
      ),
    );
  }

  async checkHealth(
    session: SessionResponse,
    input: z.infer<typeof googleHealthCheckSchema>,
    correlationId: string,
  ) {
    const claim = await this.claimHealth(
      session,
      input.customerId,
      input.generation,
      input.capabilities,
      correlationId,
    );
    let checked: {
      results: GoogleCapabilityResult[];
      observation: GoogleObservation | null;
    };
    try {
      const credential = this.cipher().open(claim.envelope, {
        recordId: claim.credentialId,
        customerId: input.customerId,
        generation: input.generation,
      });
      checked = await this.verifier.checkCapabilities(
        credential,
        input.customerId,
        input.capabilities,
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      const failure =
        error instanceof CredentialError ||
        error instanceof ServiceUnavailableException
          ? 'key-unavailable'
          : 'request-failed';
      checked = {
        results: input.capabilities.map((capability) => ({
          capability,
          scopeVerified: false,
          failure,
        })),
        observation: null,
      };
    }
    return this.finishHealth(
      session,
      input.customerId,
      input.generation,
      claim.id,
      checked.results,
      checked.observation,
    );
  }

  async check(
    session: SessionResponse,
    customerId: string,
    generation: number,
    retry: boolean,
    correlationId: string,
  ) {
    const capabilities: GoogleHealthCapability[] = [
      'customer-identity',
      'domain-observations',
    ];
    const claim = await this.claimHealth(
      session,
      customerId,
      generation,
      capabilities,
      correlationId,
    );
    if (retry)
      await this.query('SELECT cc.reset_google_access($1,$2,$3,$4,$5)', [
        ...this.actor(session),
        customerId,
        generation,
        correlationId,
      ]);
    let result;
    try {
      result = await new GoogleConnectionProvider(
        this.database.connection,
        this.cipher(),
      ).read(
        { customerId, generation, correlationId },
        AbortSignal.timeout(30_000),
        {
          actorId: session.identity.id,
          permissionVersion: session.identity.permissionVersion,
        },
      );
    } catch (error) {
      const category =
        error instanceof GoogleConnectionError
          ? googleFailureSchema.parse(error.code)
          : error instanceof CredentialError ||
              error instanceof ServiceUnavailableException
            ? 'key-unavailable'
            : 'request-failed';
      await this.finishHealth(
        session,
        customerId,
        generation,
        claim.id,
        [],
        null,
      );
      if (error instanceof GoogleStoreError && error.code === 'forbidden')
        throw new ForbiddenException({ reason: 'forbidden' });
      if (
        error instanceof GoogleStoreError &&
        error.code === 'credential-changed'
      )
        throw new ConflictException({ reason: error.code });
      throw new ServiceUnavailableException({
        reason: error instanceof GoogleStoreError ? error.code : category,
      });
    }
    await this.finishHealth(
      session,
      customerId,
      generation,
      claim.id,
      capabilities.map((capability) => ({
        capability,
        scopeVerified: true,
        failure: null,
      })),
      result.observation,
    );
    return result;
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
    replacement?: { customerId: string; generation: number },
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
      replacement
        ? 'SELECT cc.stage_google_replacement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result'
        : 'SELECT cc.stage_google_credential($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [
        ...actor,
        input.clientId,
        input.subject,
        JSON.stringify(envelope),
        correlation,
        ...(replacement
          ? [replacement.customerId, replacement.generation]
          : []),
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

  private async privateManagement(session: SessionResponse) {
    return googleCredentialManagementSchema
      .extend({ envelope: z.unknown() })
      .nullable()
      .parse(
        await this.query(
          'SELECT cc.read_google_credential_management($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async management(session: SessionResponse) {
    const record = await this.privateManagement(session);
    const config = this.configuration.deployment?.googleConnection;
    return {
      credential: record
        ? googleCredentialManagementSchema.parse({
            customerId: record.customerId,
            generation: record.generation,
            credentialId: record.credentialId,
            active: record.active,
            keyId: record.keyId,
          })
        : null,
      configuredKeyIds: config
        ? [
            config.keyId,
            ...(config.additionalKeys ?? []).map((entry) => entry.keyId),
          ]
        : [],
    };
  }

  async replace(
    session: SessionResponse,
    input: z.infer<typeof googleCredentialReplacementSchema>,
    correlation: string,
  ) {
    return this.stage(session, input, correlation, input);
  }

  async activateReplacement(
    session: SessionResponse,
    id: string,
    input: z.infer<typeof googleReplacementActivationSchema>,
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
    const current = await this.privateManagement(session);
    if (
      candidate.status !== 'ready' ||
      candidate.expectedCustomerId !== input.customerId ||
      candidate.expectedGeneration !== input.generation ||
      candidate.observation?.customerId !== input.customerId ||
      current?.generation !== input.generation ||
      current.customerId !== input.customerId
    )
      throw new ConflictException({ reason: 'credential-changed' });
    try {
      const cipher = this.cipher();
      const credential = cipher.open(stored.envelope, {
        recordId: id,
        customerId: null,
        generation: 0,
      });
      const envelope = cipher.forKey(input.keyId).seal(credential, {
        recordId: id,
        customerId: input.customerId,
        generation: input.generation + 1,
      });
      return googleCredentialManagementSchema.parse(
        await this.query(
          'SELECT cc.activate_google_replacement($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            ...actor,
            input.customerId,
            input.generation,
            JSON.stringify(envelope),
            correlation,
          ],
        ),
      );
    } catch (error) {
      if (error instanceof CredentialError)
        throw new ServiceUnavailableException({ reason: error.code });
      throw error;
    }
  }

  async rotateKey(
    session: SessionResponse,
    input: z.infer<typeof googleKeyRotationSchema>,
    correlation: string,
  ) {
    const current = await this.privateManagement(session);
    if (
      !current?.active ||
      current.customerId !== input.customerId ||
      current.generation !== input.generation ||
      current.keyId === input.keyId
    )
      throw new ConflictException({ reason: 'credential-changed' });
    try {
      const cipher = this.cipher();
      const credential = cipher.open(current.envelope, {
        recordId: current.credentialId,
        customerId: current.customerId,
        generation: current.generation,
      });
      const id = randomUUID();
      const envelope = cipher.forKey(input.keyId).seal(credential, {
        recordId: id,
        customerId: input.customerId,
        generation: input.generation + 1,
      });
      return googleCredentialManagementSchema.parse(
        await this.query(
          'SELECT cc.rotate_google_credential_key($1,$2,$3,$4,$5,$6,$7) AS result',
          [
            ...this.actor(session),
            input.customerId,
            input.generation,
            id,
            JSON.stringify(envelope),
            correlation,
          ],
        ),
      );
    } catch (error) {
      if (error instanceof CredentialError)
        throw new ServiceUnavailableException({ reason: error.code });
      throw error;
    }
  }

  async disconnect(
    session: SessionResponse,
    input: z.infer<typeof googleCredentialActivationSchema>,
    correlation: string,
  ) {
    return googleCredentialManagementSchema.parse(
      await this.query(
        'SELECT cc.disconnect_google_credential($1,$2,$3,$4,$5,$6) AS result',
        [
          ...this.actor(session),
          input.customerId,
          input.generation,
          randomUUID(),
          correlation,
        ],
      ),
    );
  }
}
