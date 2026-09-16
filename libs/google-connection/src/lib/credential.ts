import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';

const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  client_id: z.string().regex(/^\d{1,32}$/),
  client_email: z
    .string()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/),
  private_key: z.string().min(1).max(16384),
  private_key_id: z.string().min(1).max(256),
  token_uri: z.literal('https://oauth2.googleapis.com/token'),
  universe_domain: z.literal('googleapis.com').optional(),
});
export type ServiceAccountCredential = Omit<
  z.infer<typeof serviceAccountSchema>,
  'universe_domain'
>;

export class CredentialError extends Error {
  readonly code:
    | 'invalid-service-account-file'
    | 'key-unavailable'
    | 'credential-unavailable';
  constructor(code: CredentialError['code']) {
    super(code);
    this.name = 'CredentialError';
    this.code = code;
  }
}

export function validateServiceAccount(
  input: unknown,
  expectedClientId: string,
): ServiceAccountCredential {
  try {
    const parsed = serviceAccountSchema.parse(input);
    if (parsed.client_id !== expectedClientId) throw new Error();
    const key = createPrivateKey(parsed.private_key);
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
    const privateKey = key.export({ format: 'pem', type: 'pkcs8' }).toString();
    if (privateKey.length > 16384) throw new Error();
    return {
      type: parsed.type,
      client_id: parsed.client_id,
      client_email: parsed.client_email,
      private_key: privateKey,
      private_key_id: parsed.private_key_id,
      token_uri: parsed.token_uri,
    };
  } catch {
    throw new CredentialError('invalid-service-account-file');
  }
}

const contextSchema = z
  .object({
    recordId: z.uuid(),
    customerId: z
      .string()
      .regex(/^C[A-Za-z0-9]{4,31}$/)
      .nullable(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type CredentialContext = z.infer<typeof contextSchema>;

const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const base64url = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .refine(
          (value) =>
            Buffer.from(value, 'base64url').length === bytes &&
            Buffer.from(value, 'base64url').toString('base64url') === value,
        ),
    );
const envelopeSchema = z
  .object({
    format: z.literal(1),
    keyId: keyIdSchema,
    iv: base64url(12),
    tag: base64url(16),
    ciphertext: z
      .string()
      .min(1)
      .max(32768)
      .pipe(z.string().regex(/^[A-Za-z0-9_-]+$/)),
  })
  .strict();
export type CredentialEnvelope = z.infer<typeof envelopeSchema>;
export interface DelegatedCredential {
  serviceAccount: ServiceAccountCredential;
  subject: string;
}

function validated(value: unknown): DelegatedCredential {
  const input = z
    .object({
      serviceAccount: serviceAccountSchema,
      subject: z.email().max(254),
    })
    .strict()
    .parse(value);
  return {
    serviceAccount: validateServiceAccount(
      input.serviceAccount,
      input.serviceAccount.client_id,
    ),
    subject: input.subject,
  };
}

export const accessTokenSchema = z.strictObject({
  accessToken: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9._~+/-]+={0,2}$/),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scopeProfile: z.literal('customer-domain-v1'),
});
export type GoogleAccessToken = z.infer<typeof accessTokenSchema>;

function additionalData(
  context: CredentialContext,
  keyId: string,
  purpose: string,
): Buffer {
  const parsed = contextSchema.parse(context);
  if (
    purpose === 'google-access-token' &&
    (!parsed.customerId || parsed.generation < 1)
  )
    throw new Error();
  return Buffer.from(
    JSON.stringify([
      `campus-commander:${purpose}`,
      1,
      keyId,
      parsed.recordId,
      parsed.customerId,
      parsed.generation,
    ]),
  );
}

/** Encrypt persisted credentials. Callers supply keys outside the database. */
export class CredentialCipher {
  readonly #key: Buffer;
  readonly keyId: string;
  constructor(keyId: string, key: Uint8Array) {
    if (
      !keyIdSchema.safeParse(keyId).success ||
      !(key instanceof Uint8Array) ||
      key.byteLength !== 32
    )
      throw new CredentialError('key-unavailable');
    this.keyId = keyId;
    this.#key = Buffer.from(key);
  }

  seal(
    value: DelegatedCredential,
    context: CredentialContext,
  ): CredentialEnvelope {
    return this.sealValue(value, context, 'google-credential', validated);
  }

  sealAccessToken(
    value: GoogleAccessToken,
    context: CredentialContext,
  ): CredentialEnvelope {
    return this.sealValue(value, context, 'google-access-token', (input) =>
      accessTokenSchema.parse(input),
    );
  }

  private sealValue(
    value: unknown,
    context: CredentialContext,
    purpose: string,
    validate: (value: unknown) => unknown,
  ): CredentialEnvelope {
    try {
      const plaintext = Buffer.from(JSON.stringify(validate(value)));
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
        cipher.setAAD(additionalData(context, this.keyId, purpose));
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        return envelopeSchema.parse({
          format: 1,
          keyId: this.keyId,
          iv: iv.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
        });
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new CredentialError('credential-unavailable');
    }
  }

  open(value: unknown, context: CredentialContext): DelegatedCredential {
    return this.openValue(value, context, 'google-credential', validated);
  }

  openAccessToken(
    value: unknown,
    context: CredentialContext,
  ): GoogleAccessToken {
    return this.openValue(value, context, 'google-access-token', (input) =>
      accessTokenSchema.parse(input),
    );
  }

  private openValue<T>(
    value: unknown,
    context: CredentialContext,
    purpose: string,
    validate: (value: unknown) => T,
  ): T {
    try {
      const envelope = envelopeSchema.parse(value);
      if (envelope.keyId !== this.keyId) throw new Error();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key,
        Buffer.from(envelope.iv, 'base64url'),
      );
      decipher.setAAD(additionalData(context, this.keyId, purpose));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      try {
        return validate(JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new CredentialError('credential-unavailable');
    }
  }
}
