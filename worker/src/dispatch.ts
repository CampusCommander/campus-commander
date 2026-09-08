import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const maximumBodyBytes = 4096;
const maximumDelayMilliseconds = 10_000;
const identifierPattern = /^[A-Za-z0-9._:-]+$/;

export interface DispatchContext {
  secret: string;
  signal: AbortSignal;
}

interface SyntheticDispatch {
  correlationId: string;
  delayMilliseconds?: number;
  executionId: string;
  marker: string;
}

export async function handleSyntheticDispatch(
  request: IncomingMessage,
  response: ServerResponse,
  context: DispatchContext,
): Promise<boolean> {
  if (request.method !== 'POST' || request.url !== '/dispatch/synthetic') {
    return false;
  }

  if (!authorized(request.headers.authorization, context.secret)) {
    respond(response, 401, { error: 'unauthorized' });
    request.resume();
    return true;
  }

  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    respond(response, 415, { error: 'application-json-required' });
    request.resume();
    return true;
  }

  try {
    const payload = validatePayload(await readJson(request));
    console.log(
      `Synthetic dispatch accepted execution=${payload.executionId} correlation=${payload.correlationId}`,
    );
    await delay(payload.delayMilliseconds ?? 0, context.signal);
    const markerSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          correlationId: payload.correlationId,
          executionId: payload.executionId,
          marker: payload.marker,
        }),
      )
      .digest('hex');

    console.log(
      `Synthetic dispatch completed execution=${payload.executionId} correlation=${payload.correlationId} checksum=${markerSha256}`,
    );
    respond(response, 200, {
      correlationId: payload.correlationId,
      executionId: payload.executionId,
      markerSha256,
      status: 'completed',
      version: 1,
    });
  } catch (error) {
    if (error instanceof DispatchError) {
      respond(response, error.statusCode, { error: error.code });
      return true;
    }
    if (!response.headersSent) {
      respond(response, 500, { error: 'dispatch-failed' });
    }
  }

  return true;
}

export function readDispatchSecret(path: string): string {
  const secret = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (
    secret.length < 32 ||
    secret.length > 512 ||
    secret.includes('\n') ||
    secret.includes('\r')
  ) {
    throw new Error(
      'WORKER_DISPATCH_SECRET_FILE must contain one line between 32 and 512 characters.',
    );
  }
  return secret;
}

function authorized(
  header: string | undefined,
  expectedSecret: string,
): boolean {
  const prefix = 'Bearer ';
  const provided = header?.startsWith(prefix)
    ? header.slice(prefix.length)
    : '';
  const expectedDigest = createHash('sha256').update(expectedSecret).digest();
  const providedDigest = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength > maximumBodyBytes) {
    request.resume();
    throw new DispatchError(413, 'payload-too-large');
  }

  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > maximumBodyBytes) {
      throw new DispatchError(413, 'payload-too-large');
    }
    chunks.push(bytes);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DispatchError(400, 'invalid-json');
  }
}

function validatePayload(value: unknown): SyntheticDispatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DispatchError(400, 'invalid-payload');
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const allowedKeys = [
    'correlationId',
    'delayMilliseconds',
    'executionId',
    'marker',
  ];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new DispatchError(400, 'unknown-field');
  }
  if (!validIdentifier(payload.executionId, 64)) {
    throw new DispatchError(400, 'invalid-execution-id');
  }
  if (!validIdentifier(payload.correlationId, 128)) {
    throw new DispatchError(400, 'invalid-correlation-id');
  }
  if (
    typeof payload.marker !== 'string' ||
    payload.marker.length < 1 ||
    payload.marker.length > 256
  ) {
    throw new DispatchError(400, 'invalid-marker');
  }
  if (
    payload.delayMilliseconds !== undefined &&
    (!Number.isInteger(payload.delayMilliseconds) ||
      (payload.delayMilliseconds as number) < 0 ||
      (payload.delayMilliseconds as number) > maximumDelayMilliseconds)
  ) {
    throw new DispatchError(400, 'invalid-delay');
  }

  return {
    correlationId: payload.correlationId,
    delayMilliseconds: payload.delayMilliseconds as number | undefined,
    executionId: payload.executionId,
    marker: payload.marker,
  };
}

function validIdentifier(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    identifierPattern.test(value)
  );
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DispatchError(503, 'worker-stopping'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DispatchError(503, 'worker-stopping'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

function respond(response: ServerResponse, statusCode: number, body: object) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

class DispatchError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
