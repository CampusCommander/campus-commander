import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  googleCustomerIdSchema,
  googleFailureSchema,
  googleObservationSchema,
} from '@campus/application-contracts';
import {
  CredentialCipher,
  CredentialError,
  type GoogleAccessToken,
} from './credential';
import { GoogleConnectionError, GoogleCustomerVerifier } from './provider';

export interface GoogleConnectionDatabase {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
const requestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  correlationId: z.uuid(),
});
export type GoogleReadRequest = z.infer<typeof requestSchema>;
const resultSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  observedAt: z.string(),
  observation: googleObservationSchema,
});
const claimSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('failed'), failure: googleFailureSchema }),
  z.strictObject({
    status: z.literal('renew'),
    credentialId: z.uuid(),
    envelope: z.unknown(),
  }),
  z.strictObject({
    status: z.literal('cached'),
    credentialId: z.uuid(),
    tokenId: z.uuid(),
    envelope: z.unknown(),
    expiresAt: z.number().int().positive(),
  }),
]);
export class GoogleStoreError extends Error {
  readonly code: 'credential-changed' | 'connection-store-unavailable';
  constructor(code: GoogleStoreError['code']) {
    super(code);
    this.name = 'GoogleStoreError';
    this.code = code;
  }
}

/** Coordinate one token generation across API and worker processes. */
export class GoogleConnectionProvider {
  private readonly database: GoogleConnectionDatabase;
  private readonly cipher: CredentialCipher;
  private readonly verifier: Pick<GoogleCustomerVerifier, 'renew' | 'observe'>;
  constructor(
    database: GoogleConnectionDatabase,
    cipher: CredentialCipher,
    verifier: Pick<
      GoogleCustomerVerifier,
      'renew' | 'observe'
    > = new GoogleCustomerVerifier(),
  ) {
    this.database = database;
    this.cipher = cipher;
    this.verifier = verifier;
  }

  private async query(sql: string, values: unknown[]) {
    try {
      return (await this.database.query(sql, values)).rows[0]?.['result'];
    } catch (error) {
      const parsed = z
        .object({ code: z.string(), detail: z.string().optional() })
        .safeParse(error);
      if (
        parsed.success &&
        parsed.data.code === 'P0001' &&
        parsed.data.detail === 'credential-changed'
      )
        throw new GoogleStoreError('credential-changed');
      throw new GoogleStoreError('connection-store-unavailable');
    }
  }

  private async access(
    input: GoogleReadRequest,
    signal: AbortSignal,
  ): Promise<{ token: GoogleAccessToken; tokenId: string }> {
    const leaseId = randomUUID();
    while (!signal.aborted) {
      const claim = claimSchema.parse(
        await this.query(
          'SELECT cc.acquire_google_access($1,$2,$3) AS result',
          [input.customerId, input.generation, leaseId],
        ),
      );
      if (claim.status === 'failed')
        throw new GoogleConnectionError(claim.failure);
      if (claim.status === 'pending') {
        await delay(200, undefined, { signal });
        continue;
      }
      const context = {
        recordId: claim.credentialId,
        customerId: input.customerId,
        generation: input.generation,
      };
      if (claim.status === 'cached') {
        const token = this.cipher.openAccessToken(claim.envelope, context);
        if (
          token.expiresAt !== claim.expiresAt ||
          token.expiresAt <= Date.now() + 60_000
        )
          throw new GoogleConnectionError('invalid-response');
        return { token, tokenId: claim.tokenId };
      }
      let token;
      try {
        token = await this.verifier.renew(
          this.cipher.open(claim.envelope, context),
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
      } catch (error) {
        if (!(error instanceof CredentialError)) {
          const failure =
            error instanceof GoogleConnectionError
              ? error.code
              : 'network-failure';
          await this.query(
            'SELECT cc.finish_google_access($1,$2,$3,NULL,NULL,$4,$5)',
            [
              input.customerId,
              input.generation,
              leaseId,
              failure,
              input.correlationId,
            ],
          );
        }
        throw error;
      }
      const envelope = this.cipher.sealAccessToken(token, context);
      await this.query(
        'SELECT cc.finish_google_access($1,$2,$3,$4,$5,NULL,$6)',
        [
          input.customerId,
          input.generation,
          leaseId,
          JSON.stringify(envelope),
          new Date(token.expiresAt).toISOString(),
          input.correlationId,
        ],
      );
      return { token, tokenId: leaseId };
    }
    throw new GoogleConnectionError('network-failure');
  }

  async read(request: GoogleReadRequest, stopping?: AbortSignal) {
    const input = requestSchema.parse(request);
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(stopping ? [stopping] : []),
    ]);
    try {
      const { token, tokenId } = await this.access(input, signal);
      let observation;
      try {
        observation = await this.verifier.observe(token, signal);
        if (observation.customerId !== input.customerId)
          throw new GoogleConnectionError('wrong-customer');
      } catch (error) {
        const failure =
          error instanceof GoogleConnectionError
            ? error.code
            : 'network-failure';
        await this.query('SELECT cc.reject_google_access($1,$2,$3,$4,$5)', [
          input.customerId,
          input.generation,
          tokenId,
          failure,
          input.correlationId,
        ]);
        throw error;
      }
      return resultSchema.parse(
        await this.query(
          'SELECT cc.record_google_observation($1,$2,$3,$4) AS result',
          [
            input.customerId,
            input.generation,
            JSON.stringify(observation),
            input.correlationId,
          ],
        ),
      );
    } catch (error) {
      if (
        error instanceof GoogleConnectionError ||
        error instanceof GoogleStoreError ||
        error instanceof CredentialError
      )
        throw error;
      throw new GoogleConnectionError(
        signal.aborted ? 'network-failure' : 'invalid-response',
      );
    }
  }
}
