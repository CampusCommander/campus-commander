import { json, type NextFunction, type Request, type Response } from 'express';
import { USER_ATTRIBUTE_PREVIEW_BODY_LIMIT } from './users/user-attribute-previews';

/**
 * The body parser of the one route above the 100 KB JSON default. One edit list carries 2,500
 * edits on 500 users (E17), so an ordinary short-value save is about 232 KB.
 */
const previewBody = json({ limit: USER_ATTRIBUTE_PREVIEW_BODY_LIMIT });

/**
 * Parse the value preview POST under its bounded cap, and leave every other route to the Nest
 * default. The parser runs before the default one, so the preview body is read once.
 */
export function previewBodyParser(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (
    request.method === 'POST' &&
    request.path === '/api/users/attribute-previews'
  ) {
    previewBody(request, response, next);
    return;
  }
  next();
}

/** Answer an oversized preview body with the 413 of the edge, not a 503. */
export function previewBodyError(
  error: unknown,
  request: Request & { correlationId?: string },
  response: Response,
  next: NextFunction,
): void {
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.too.large' && !response.headersSent) {
    response.status(413).json({
      code: 'payload-too-large',
      message: 'The request exceeds the size limit.',
      correlationId: request.correlationId,
    });
    return;
  }
  next(error);
}
