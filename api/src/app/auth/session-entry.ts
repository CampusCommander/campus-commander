import { z } from 'zod';

export const sessionSchema = z.strictObject({
  principalId: z.uuid(),
  permissionVersion: z.number().int(),
  expiresAt: z.number().int(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * The verified sign-in email, the person's Google Workspace subject for Drive. Null without a
   * verified email. An entry written before this key existed reads as null.
   */
  driveSubject: z.string().nullable().default(null),
});

/** How long a revoked session key keeps reporting the access change to the old cookie. */
export const accessChangedSeconds = 60;

const accessChangedSchema = z.strictObject({
  accessChanged: z.literal(true),
  principalId: z.uuid(),
});

export type Session = z.infer<typeof sessionSchema>;

export type SessionEntry =
  | { kind: 'session'; session: Session }
  | { kind: 'access-changed'; principalId: string };

/**
 * Read one session key value. A revoked entry reports the access change and holds no session data,
 * so every later request with the old cookie reads the same reason.
 */
export function readSessionEntry(raw: string): SessionEntry {
  const value: unknown = JSON.parse(raw);
  const changed = accessChangedSchema.safeParse(value);
  if (changed.success)
    return { kind: 'access-changed', principalId: changed.data.principalId };
  return { kind: 'session', session: sessionSchema.parse(value) };
}

/** The value that replaces a session when its permission version no longer matches. */
export function accessChangedEntry(principalId: string): string {
  return JSON.stringify({ accessChanged: true, principalId });
}
