import type { NextFunction, Request, Response } from 'express';
import { USER_ATTRIBUTE_PREVIEW_BODY_LIMIT } from './users/user-attribute-previews';

/** The one route above the 100 KB JSON default. */
const previewPath = '/api/users/attribute-previews';

/** Answer an oversized preview body with the 413 of the edge, not a 503. */
function refuseLarge(
  request: Request & { correlationId?: string },
  response: Response,
): void {
  response.status(413).json({
    code: 'payload-too-large',
    message: 'The request exceeds the size limit.',
    correlationId: request.correlationId,
  });
}

/**
 * Read the preview body under its 64 MiB cap. A declared size above the cap answers before the
 * read starts, and the loop below counts the bytes of a chunked body. A refused body never
 * reaches the controller.
 */
async function readPreviewBody(
  request: Request & { correlationId?: string; _body?: boolean },
  response: Response,
  next: NextFunction,
): Promise<void> {
  request._body = true;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > USER_ATTRIBUTE_PREVIEW_BODY_LIMIT) {
        refuseLarge(request, response);
        response.once('finish', () => request.destroy());
        return;
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (!request.destroyed && !response.headersSent) next(error);
    return;
  }
  const body = Buffer.concat(chunks);
  try {
    // The cap bounds the string that one parse builds, so this route parses the buffer itself.
    request.body = JSON.parse(body.toString('utf8'));
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ERR_STRING_TOO_LONG') {
      refuseLarge(request, response);
      return;
    }
    next(error);
    return;
  }
  next();
}

/**
 * Parse the value preview POST under its bounded cap, and leave every other route to the Nest
 * default. A declared size above the cap answers before the read starts, so the API never
 * buffers a body above the cap.
 */
export function previewBodyParser(
  request: Request & { correlationId?: string; _body?: boolean },
  response: Response,
  next: NextFunction,
): void {
  if (
    request.method !== 'POST' ||
    request.path !== previewPath ||
    !request.is('application/json')
  ) {
    next();
    return;
  }
  const declared = Number(request.headers['content-length']);
  if (
    Number.isFinite(declared) &&
    declared > USER_ATTRIBUTE_PREVIEW_BODY_LIMIT
  ) {
    refuseLarge(request, response);
    return;
  }
  void readPreviewBody(request, response, next);
}

/** Translate a parser oversize refusal to the 413 of the edge. */
export function previewBodyError(
  error: unknown,
  request: Request & { correlationId?: string },
  response: Response,
  next: NextFunction,
): void {
  const refused = error as { type?: string; code?: string } | null;
  if (
    (refused?.type === 'entity.too.large' ||
      refused?.code === 'ERR_STRING_TOO_LONG') &&
    !response.headersSent
  ) {
    refuseLarge(request, response);
    return;
  }
  next(error);
}
