import { z } from 'zod';

export class OnboardingError extends Error {}
const webClient = z.object({
  client_id: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/)
    .max(512),
  client_secret: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(100),
  auth_uri: z
    .literal('https://accounts.google.com/o/oauth2/auth')
    .or(z.literal('https://accounts.google.com/o/oauth2/v2/auth'))
    .optional(),
  token_uri: z.literal('https://oauth2.googleapis.com/token').optional(),
  auth_provider_x509_cert_url: z
    .literal('https://www.googleapis.com/oauth2/v1/certs')
    .optional(),
});

export function parseGoogleClient(bytes, publicOrigin) {
  if (Buffer.byteLength(bytes) > 65536)
    throw new OnboardingError(
      'The Google client file exceeds 64 KiB. Download the Web application client JSON.',
    );
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new OnboardingError(
      'The file is not valid JSON. Download the Google Web application client JSON.',
    );
  }
  if (!value?.web || value.installed || value.type === 'service_account')
    throw new OnboardingError(
      'Select a Web application client. Desktop and service account credentials cannot configure application sign-in.',
    );
  const parsed = webClient.safeParse(value.web);
  if (!parsed.success)
    throw new OnboardingError(
      'The Google client JSON contains invalid credentials or provider endpoints. Download a new Web application client file.',
    );
  const callback = `${new URL(publicOrigin).origin}/api/auth/callback`;
  if (!parsed.data.redirect_uris.includes(callback))
    throw new OnboardingError(
      `Add ${callback} to the Google client redirect URIs, then download its JSON again.`,
    );
  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret,
    projectId: parsed.data.project_id,
    callback,
  };
}
