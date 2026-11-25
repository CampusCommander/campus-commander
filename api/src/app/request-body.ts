import { json, type NextFunction, type Request, type Response } from 'express';
import { USER_ATTRIBUTE_PREVIEW_BODY_LIMIT } from './users/user-attribute-previews';

/**
 * The body parser of the one route above the 100 KB JSON default. One edit list carries 2,500
 * edits on 500 users (E17), each with a requested list and a baseline list of at most 150 values
 * of 500 characters (B section 3), so the cap comes from that supported shape.
 */
const previewBody = json({ limit: USER_ATTRIBUTE_PREVIEW_BODY_LIMIT });

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
 * Parse the value preview POST under its bounded cap, and leave every other route to the Nest
 * default. The parser runs before the default one, so the preview body is read once. A declared
 * size above the cap answers before the read starts, so the API never buffers an oversized body.
 */
export function previewBodyParser(
  request: Request & { correlationId?: string },
  response: Response,
  next: NextFunction,
): void {
  if (
    request.method === 'POST' &&
    request.path === '/api/users/attribute-previews'
  ) {
    const declared = Number(request.headers['content-length']);
    if (
      Number.isFinite(declared) &&
      declared > USER_ATTRIBUTE_PREVIEW_BODY_LIMIT
    ) {
      refuseLarge(request, response);
      return;
    }
    previewBody(request, response, next);
    return;
  }
  next();
}

/** Translate the parser's own oversize refusal to the 413 of the edge. */
export function previewBodyError(
  error: unknown,
  request: Request & { correlationId?: string },
  response: Response,
  next: NextFunction,
): void {
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.too.large' && !response.headersSent) {
    refuseLarge(request, response);
    return;
  }
  next(error);
}
