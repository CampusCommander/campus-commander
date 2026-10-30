/**
 * Test double for the Drive v3 and Sheets v4 endpoints. Only `*.test.mjs` files import it.
 * Production code calls the real Google endpoints.
 *
 * `answer(call, index)` answers one request. It returns `{ status?, data }`, and a status outside
 * 2xx throws the way gaxios does, with `error.response`. It returns an Error to throw that error.
 * `call` holds the URL, the query, the method, the headers, and the parsed JSON body.
 */
import { Readable } from 'node:stream';

export function fakeDrive(answer) {
  const sent = [];
  const client = {
    async request(options) {
      const url = new URL(options.url);
      for (const [name, value] of Object.entries(options.params ?? {}))
        url.searchParams.set(name, String(value));
      const call = {
        url: url.toString(),
        origin: url.origin,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body:
          typeof options.body === 'string' && options.body !== ''
            ? JSON.parse(options.body)
            : undefined,
        responseType: options.responseType ?? 'json',
      };
      sent.push(call);
      const reply = answer(call, sent.length - 1);
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      if (status < 200 || status >= 300) {
        const response = {
          status,
          headers: new Headers(reply.headers ?? {}),
          data: reply.data ?? '',
        };
        throw Object.assign(new Error(`HTTP ${status}`), { response });
      }
      return {
        status,
        headers: new Headers(reply.headers ?? {}),
        data: reply.data,
      };
    },
  };
  return { client, sent };
}

/** A Google error answer, in the shape `failure` reads. */
export function googleError(status, reason) {
  return {
    status,
    data: { error: { code: status, errors: [{ reason }], message: reason } },
  };
}

/** A Sheets metadata answer from tab properties. */
export function sheetAnswer(tabs) {
  return {
    status: 200,
    data: { sheets: tabs.map((properties) => ({ properties })) },
  };
}

/** A values answer. An absent list stands for a range with no data. */
export function valuesAnswer(values) {
  return { status: 200, data: values === undefined ? {} : { values } };
}

/** A streamed file body. */
export function streamAnswer(chunks) {
  return { status: 200, data: Readable.from(chunks) };
}
