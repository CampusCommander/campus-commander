import { constants as bufferConstants } from 'node:buffer';
import type { NextFunction, Request, Response } from 'express';
import { USER_ATTRIBUTE_PREVIEW_BODY_LIMIT } from './users/user-attribute-previews';

/** The largest JSON text that one `JSON.parse` holds, in UTF-16 units. */
const MAX_TEXT_UNITS = bufferConstants.MAX_STRING_LENGTH;
/** The chunk of one streaming count. */
const TEXT_CHUNK_BYTES = 4 * 1024 * 1024;
/** The one route above the 100 KB JSON default. */
const previewPath = '/api/users/attribute-previews';

/**
 * The UTF-16 units of the JSON text that one body decodes to. The count streams, so it never
 * holds the complete text before the parser builds it.
 */
export function previewTextUnits(body: Buffer): number {
  const decoder = new TextDecoder('utf-8');
  let units = 0;
  for (let offset = 0; offset < body.length; offset += TEXT_CHUNK_BYTES) {
    units += decoder.decode(body.subarray(offset, offset + TEXT_CHUNK_BYTES), {
      stream: true,
    }).length;
    if (units > MAX_TEXT_UNITS) return units;
  }
  return units + decoder.decode().length;
}

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
 * Read the preview body under two finite bounds. The byte cap is the boundary of one parse: a
 * UTF-8 body yields at most one UTF-16 unit per byte, and one unit takes at most three bytes, so
 * a larger body cannot fit one `JSON.parse`. The text ceiling then counts the decoded units. The
 * supported bodies of E17 and B section 3 pass both bounds, whatever JSON escaping they carry.
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
  if (body.length > MAX_TEXT_UNITS && previewTextUnits(body) > MAX_TEXT_UNITS) {
    refuseLarge(request, response);
    return;
  }
  try {
    // Buffer.toString holds one string of up to MAX_TEXT_UNITS units, which the text ceiling
    // above has already checked. body-parser's iconv path fails at this size, so this route
    // parses the buffer itself.
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
