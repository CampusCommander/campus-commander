/**
 * Test double for a Google batch endpoint. It parses each multipart request and answers each part.
 * Replies come back in reverse order, so tests prove Content-ID matching.
 */
const crlf = '\r\n';

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return index < 0
    ? [text, '']
    : [text.slice(0, index), text.slice(index + separator.length)];
}

/** Read the parts the service sent. `key` is the last path segment, decoded. */
export function parseBatchRequest(options) {
  const boundary = /boundary=([^;\s]+)/.exec(
    options.headers['content-type'],
  )[1];
  return options.body
    .split(`--${boundary}`)
    .slice(1)
    .filter((section) => !section.startsWith('--'))
    .map((section) => {
      const [outer, http] = splitOnce(
        section.replace(/^\r\n/, ''),
        crlf + crlf,
      );
      const contentId = /Content-ID: <([^>]+)>/.exec(outer)[1];
      const [head, rawBody] = splitOnce(http, crlf + crlf);
      const [line, ...headerLines] = head.split(crlf);
      const [method, target] = line.split(' ');
      const url = new URL(target, 'https://batch.invalid');
      const headers = Object.fromEntries(
        headerLines.map((header) => {
          const colon = header.indexOf(':');
          return [
            header.slice(0, colon).toLowerCase(),
            header.slice(colon + 1).trim(),
          ];
        }),
      );
      const text = rawBody.trim();
      return {
        contentId,
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        key: decodeURIComponent(url.pathname.split('/').at(-1)),
        headers,
        body: text ? JSON.parse(text) : undefined,
      };
    });
}

/** Build a multipart reply. Each answer is `{ contentId, status, body?, raw?, headers? }`. */
export function multipartReply(answers, boundary = 'batch_reply') {
  return (
    answers
      .map(({ contentId, status, body, raw, headers = {} }) =>
        [
          `--${boundary}`,
          'Content-Type: application/http',
          `Content-ID: <response-${contentId}>`,
          '',
          `HTTP/1.1 ${status} ${status < 300 ? 'OK' : 'Error'}`,
          'Content-Type: application/json; charset=UTF-8',
          ...Object.entries(headers).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          '',
          raw ?? (body === undefined ? '' : JSON.stringify(body)),
          '',
        ].join(crlf),
      )
      .join('') + `--${boundary}--${crlf}`
  );
}

/**
 * `answer(part, round)` returns `{ status, body?, raw?, headers?, contentId? }`, or null to omit the part.
 * `outer(round, options)` returns undefined, an Error to throw, or `{ status, headers?, data? }`.
 * A non-2xx outer answer throws the way gaxios does, with `error.response`.
 */
export function fakeGoogle(answer, { outer, delay = false } = {}) {
  const sent = [];
  const requests = [];
  const state = { mints: 0, active: 0, maxActive: 0 };
  const client = {
    async request(options) {
      const round = requests.length;
      requests.push(options);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delay) await new Promise((resolve) => setImmediate(resolve));
        const parts = parseBatchRequest(options);
        sent.push(parts);
        const forced = outer?.(round, options);
        if (forced instanceof Error) throw forced;
        if (forced) {
          const response = {
            status: forced.status,
            headers: new Headers(forced.headers ?? {}),
            data: forced.data ?? '',
          };
          if (forced.status >= 200 && forced.status < 300) return response;
          throw Object.assign(new Error(`HTTP ${forced.status}`), { response });
        }
        const answers = parts
          .flatMap((part) => {
            const reply = answer(part, round);
            return reply ? [{ contentId: part.contentId, ...reply }] : [];
          })
          .reverse();
        return {
          status: 200,
          headers: new Headers({
            'content-type': 'multipart/mixed; boundary=batch_reply',
          }),
          data: multipartReply(answers),
        };
      } finally {
        state.active -= 1;
      }
    },
  };
  return {
    client,
    sent,
    requests,
    state,
    getClient: async () => {
      state.mints += 1;
      return client;
    },
    keys: () => sent.map((round) => round.map((part) => part.key)),
  };
}

/** Answer each key from its own list, one reply per send. The last reply repeats. */
export function perKey(table) {
  const used = new Map();
  return (part) => {
    const replies = table[part.key];
    const index = used.get(part.key) ?? 0;
    used.set(part.key, index + 1);
    return replies[Math.min(index, replies.length - 1)];
  };
}

/**
 * A clock that advances only when the service sleeps. Jitter is fixed at 0.5.
 * Each sleep yields one event-loop turn, so a loop defect cannot starve test timeouts.
 */
export function testClock() {
  const clock = { time: 0, waits: [] };
  clock.now = () => clock.time;
  clock.random = () => 0.5;
  clock.sleep = async (milliseconds, signal) => {
    clock.waits.push(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
    if (!signal.aborted) clock.time += milliseconds;
  };
  return clock;
}

export const thing = (id, extra = {}) => ({
  id,
  method: 'GET',
  path: `/admin/directory/v1/things/${encodeURIComponent(id)}`,
  ...extra,
});
