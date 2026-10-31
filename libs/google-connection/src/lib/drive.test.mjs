import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  createCsvReader,
  createCsvWriter,
} from '@campus/application-contracts';
import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_DRIVE_SOURCE_BYTES,
  GOOGLE_DRIVE_WINDOW_BYTES,
  GOOGLE_DRIVE_WINDOW_ROWS,
  GOOGLE_SHEET_MIME_TYPE,
  GoogleDriveClient,
  columnName,
  personDriveClient,
  personDriveToken,
} from './drive.ts';
import {
  fakeDrive,
  googleError,
  sheetAnswer,
  streamAnswer,
  valuesAnswer,
} from './drive-fake.mjs';

const credential = {
  subject: 'administrator@example.org',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: 'synthetic-private-key',
    private_key_id: 'fixture',
  },
};
const person = 'person@example.org';
const mintedToken = 'fixture-drive-token';
const signal = AbortSignal.timeout(10_000);
const sheetProperties = {
  sheetId: 0,
  title: 'Devices',
  index: 0,
  gridProperties: { columnCount: 2, rowCount: 100 },
};

/** The rows a write sends, in order. */
async function* rows(...items) {
  yield* items;
}
const ok = (data) => ({ status: 200, data });

/** Collect an async iterable into an array. */
async function collected(source) {
  const items = [];
  for await (const item of source) items.push(item);
  return items;
}

/** A response body of exactly `bytes` bytes, streamed as a Google answer arrives. */
function filled(bytes, prefix = '', suffix = '', padding = 0) {
  let fill = bytes - prefix.length - suffix.length - padding;
  return new ReadableStream({
    start(controller) {
      if (prefix !== '') controller.enqueue(Buffer.from(prefix));
      const chunk = new Uint8Array(64 * 1024).fill(0x78);
      while (fill > 0) {
        const take = Math.min(fill, chunk.length);
        controller.enqueue(chunk.subarray(0, take));
        fill -= take;
      }
      if (suffix !== '') controller.enqueue(Buffer.from(suffix));
      // Trailing JSON whitespace, which a parse drops and a re-serialization loses.
      const spaces = new Uint8Array(64 * 1024).fill(0x20);
      let left = padding;
      while (left > 0) {
        const take = Math.min(left, spaces.length);
        controller.enqueue(spaces.subarray(0, take));
        left -= take;
      }
      controller.close();
    },
  });
}
const jsonWindow = (bytes, padding = 0) =>
  filled(bytes, '{"values":[["', '"]]}', padding);
const rawWindow = (bytes) => filled(bytes);

/**
 * A real OAuth2Client whose transport answers from memory. Gaxios and fetch carry the response, so
 * a window test counts the bytes of a real answer rather than a re-serialized object.
 */
function byteClient(body, headers = {}) {
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: mintedToken });
  oauth.transporter.defaults.fetchImplementation = async (input) =>
    new URL(String(input)).pathname.includes('/values/')
      ? new Response(body(), { status: 200, headers })
      : new Response(JSON.stringify(sheetAnswer([sheetProperties]).data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  return oauth;
}

/** A values answer as the JSON text of a response body. */
const jsonBody = (values) => JSON.stringify({ values });

/** A dropped connection, as a body read raises it. */
const resetError = () =>
  Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

/** A body that answers a JSON prefix and then drops the connection. */
function resetWindow(prefix) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(prefix));
      controller.error(resetError());
    },
  });
}

/**
 * A real OAuth2Client whose values answers come from `window(index, url)`. The index counts values
 * requests from zero, and every answer is a byte stream, so the client counts real response bytes.
 */
function streamClient(properties, window) {
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: mintedToken });
  const sent = [];
  let windows = 0;
  oauth.transporter.defaults.fetchImplementation = async (input) => {
    const url = new URL(String(input));
    sent.push(url);
    if (!url.pathname.includes('/values/'))
      return new Response(JSON.stringify(sheetAnswer([properties]).data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const body = window(windows, url);
    windows += 1;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { oauth, sent };
}

/** The values ranges that the transport answered, in request order. */
const windowRanges = (sent) =>
  sent
    .filter((url) => url.pathname.includes('/values/'))
    .map((url) => decodeURIComponent(url.pathname.split('/values/')[1]));

/** Read the rows of a tab through the CSV writer and reader that the import stage uses. */
async function csvRecords(rows) {
  const writer = createCsvWriter();
  let stage = writer.start();
  for await (const row of rows) stage += writer.row(row);
  const reader = createCsvReader();
  return [...reader.push(stage), ...reader.end()];
}

function reply(call) {
  if (call.path === '/drive/v3/files/fixture-sheet')
    return ok({ name: 'Devices', mimeType: GOOGLE_SHEET_MIME_TYPE });
  if (call.path === '/drive/v3/files/fixture-csv')
    return ok({
      name: 'Devices.csv',
      mimeType: 'text/csv',
      size: '32',
      modifiedTime: '2026-10-30T12:00:00.000Z',
    });
  if (call.path === '/v4/spreadsheets/fixture-sheet')
    return sheetAnswer([sheetProperties]);
  if (call.path.includes('/values/')) return valuesAnswer([['a', 'b']]);
  if (call.path === '/v4/spreadsheets')
    return ok({
      spreadsheetId: 'fixture-spreadsheet',
      sheets: [{ properties: { sheetId: 0 } }],
    });
  return ok({});
}

test('one drive.file token for the person, sent on every call', async (t) => {
  const mints = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    mints.push({ subject: this.subject, scopes: this.scopes });
    return { token: mintedToken };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  const sent = [];
  const transporter = Object.getPrototypeOf(new OAuth2Client().transporter);
  t.mock.method(transporter, 'request', async (options) => {
    const url = new URL(options.url);
    for (const [name, value] of Object.entries(options.params ?? {}))
      url.searchParams.set(name, String(value));
    sent.push({
      path: url.pathname,
      authorization: options.headers.get('authorization'),
    });
    if (options.responseType === 'stream') {
      const bytes = url.pathname.includes('/values/')
        ? Buffer.from(JSON.stringify(reply({ path: url.pathname }).data))
        : Buffer.from('a,b\n');
      return {
        status: 200,
        headers: new Headers(),
        data: Readable.from([bytes]),
      };
    }
    const answer = reply({ path: url.pathname });
    return { status: 200, headers: new Headers(), data: answer.data };
  });

  const client = await personDriveClient(credential, person, signal, {
    sleep: async () => undefined,
  });
  await client.file('fixture-csv');
  const tabs = await client.tabs('fixture-sheet');
  const tab = await client.readTab('fixture-sheet', 0);
  await collected(tab.rows());
  const sheet = await client.createSheet('Devices');
  await client.setTextFormat(sheet.spreadsheetId, sheet.sheetId, 10);
  await client.writeRows(sheet.spreadsheetId, tab.title, 2, rows(['a', 'b']));
  await collected(client.stream('fixture-csv'));

  assert.equal(mints.length, 1, 'One mint serves the whole client.');
  assert.deepEqual(mints[0].scopes, [GOOGLE_DRIVE_SCOPE]);
  assert.equal(mints[0].subject, person);
  assert.equal(tabs.fileId, 'fixture-sheet');
  const authorization = `Bearer ${mintedToken}`;
  assert.deepEqual(
    sent.map((item) => item.authorization),
    Array.from({ length: sent.length }, () => authorization),
  );
  assert.deepEqual(
    sent.map((item) => item.path),
    [
      '/drive/v3/files/fixture-csv',
      '/drive/v3/files/fixture-sheet',
      '/v4/spreadsheets/fixture-sheet',
      '/v4/spreadsheets/fixture-sheet',
      "/v4/spreadsheets/fixture-sheet/values/'Devices'!A1%3AB1000",
      '/v4/spreadsheets',
      '/v4/spreadsheets/fixture-spreadsheet:batchUpdate',
      "/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1%3AB1",
      '/drive/v3/files/fixture-csv',
    ],
  );
});

/** The token refusals of design section 4: delegation, account, scope, and transport. */
const tokenRefusals = [
  [
    'delegation',
    () => {
      throw {
        response: { status: 401, data: { error: 'unauthorized_client' } },
      };
    },
    () => ({ scopes: ['fixture'], expiry_date: Date.now() + 3_500_000 }),
    'delegation-not-authorized',
  ],
  [
    'account',
    () => {
      throw { response: { status: 400, data: { error: 'invalid_grant' } } };
    },
    () => ({ scopes: ['fixture'], expiry_date: Date.now() + 3_500_000 }),
    'credential-rejected',
  ],
  [
    'scope',
    () => ({ token: 'fixture-drive-token' }),
    () => ({
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      expiry_date: Date.now() + 3_500_000,
    }),
    'scope-mismatch',
  ],
  [
    'network',
    () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
    () => ({ scopes: ['fixture'], expiry_date: Date.now() + 3_500_000 }),
    'network-failure',
  ],
];

for (const [name, token, info, code] of tokenRefusals)
  test(`the ${name} refusal keeps its code`, async (t) => {
    t.mock.method(JWT.prototype, 'getAccessToken', async () => token());
    t.mock.method(JWT.prototype, 'getTokenInfo', async () => info());
    await assert.rejects(personDriveClient(credential, person, signal), {
      name: 'GoogleConnectionError',
      code,
    });
  });

test('the person subject must be an email address', async () => {
  await assert.rejects(personDriveClient(credential, 'not-an-email', signal), {
    name: 'ZodError',
  });
});

test('mints the person token with its expiry', async (t) => {
  const expiresAt = Date.now() + 3_500_000;
  t.mock.method(JWT.prototype, 'getAccessToken', async () => ({
    token: mintedToken,
  }));
  t.mock.method(JWT.prototype, 'getTokenInfo', async () => ({
    scopes: [GOOGLE_DRIVE_SCOPE],
    expiry_date: expiresAt,
  }));
  assert.deepEqual(await personDriveToken(credential, person, signal), {
    accessToken: mintedToken,
    expiresAt,
  });
});

test('reads the metadata of a CSV file', async () => {
  const google = fakeDrive(reply);
  const client = new GoogleDriveClient(google.client, signal);
  assert.deepEqual(await client.file('fixture-csv'), {
    fileId: 'fixture-csv',
    name: 'Devices.csv',
    mimeType: 'text/csv',
    sizeBytes: 32,
    modifiedAt: '2026-10-30T12:00:00.000Z',
  });
  assert.equal(google.sent[0].method, 'GET');
  assert.equal(google.sent[0].path, '/drive/v3/files/fixture-csv');
  assert.equal(
    google.sent[0].query.fields,
    'id,name,mimeType,size,modifiedTime',
  );
});

test('a Google Sheet metadata answer holds no size and no edit time', async () => {
  const google = fakeDrive(reply);
  const client = new GoogleDriveClient(google.client, signal);
  const file = await client.file('fixture-sheet');
  assert.equal(file.mimeType, GOOGLE_SHEET_MIME_TYPE);
  assert.equal(file.sizeBytes, null);
  assert.equal(file.modifiedAt, null);
});

for (const status of [403, 404])
  test(`a ${status} metadata answer is drive-file-unavailable`, async () => {
    const google = fakeDrive(() => googleError(status, 'notFound'));
    const client = new GoogleDriveClient(google.client, signal);
    await assert.rejects(client.file('fixture-csv'), {
      name: 'GoogleDriveError',
      code: 'drive-file-unavailable',
    });
    assert.equal(google.sent.length, 1, 'A 4xx answer never repeats.');
  });

test('lists the tabs of a Sheet', async () => {
  const google = fakeDrive((call) =>
    call.path === '/drive/v3/files/fixture-sheet'
      ? ok({ name: 'Devices', mimeType: GOOGLE_SHEET_MIME_TYPE })
      : sheetAnswer([
          { sheetId: 7, title: 'Devices', index: 0 },
          { sheetId: 3, title: 'Notes', index: 1 },
        ]),
  );
  const client = new GoogleDriveClient(google.client, signal);
  assert.deepEqual(await client.tabs('fixture-sheet'), {
    fileId: 'fixture-sheet',
    tabs: [
      { tabId: 7, title: 'Devices', index: 0 },
      { tabId: 3, title: 'Notes', index: 1 },
    ],
  });
  assert.equal(
    google.sent[1].query.fields,
    'sheets(properties(sheetId,title,index))',
  );
});

test('a CSV file is not a Sheet', async () => {
  const google = fakeDrive(() =>
    ok({ name: 'Devices.csv', mimeType: 'text/csv' }),
  );
  const client = new GoogleDriveClient(google.client, signal);
  await assert.rejects(client.tabs('fixture-csv'), {
    name: 'GoogleDriveError',
    code: 'not-a-sheet',
  });
  assert.equal(
    google.sent.length,
    1,
    'The type check runs before the tab read.',
  );
});

test('a missing tab refuses as tab-missing', async () => {
  const google = fakeDrive(() => sheetAnswer([sheetProperties]));
  const client = new GoogleDriveClient(google.client, signal);
  await assert.rejects(client.readTab('fixture-sheet', 9), {
    name: 'GoogleDriveError',
    code: 'tab-missing',
  });
});

test('reads a tab in windows of one thousand rows and pads each row', async () => {
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 10, rowCount: 2001 },
        },
      ]);
    const start = Number(/!A(\d+):/.exec(decodeURIComponent(call.path))[1]) - 1;
    if (start === 0)
      return valuesAnswer([['Device ID', 'Serial'], ['device-1']]);
    if (start === 1000)
      return valuesAnswer(
        Array.from({ length: 1000 }, () => ['device', 'serial']),
      );
    return valuesAnswer([['device-last', 'serial-last']]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  const read = await collected(tab.rows());
  assert.equal(tab.title, 'Devices');
  assert.equal(
    read.length,
    2001,
    'The trimmed rows of the first window hold their positions.',
  );
  assert.deepEqual(read[0], ['Device ID', 'Serial']);
  assert.deepEqual(
    read[1],
    ['device-1', ''],
    'A short row pads to the header.',
  );
  assert.deepEqual(read[2], ['', ''], 'A trimmed row keeps its place.');
  assert.deepEqual(
    read[1000],
    ['device', 'serial'],
    'Window two starts at source row 1,001.',
  );
  assert.deepEqual(read[2000], ['device-last', 'serial-last']);
  assert.deepEqual(
    google.sent
      .filter((call) => call.path.includes('/values/'))
      .map((call) => decodeURIComponent(call.path.split('/values/')[1])),
    ["'Devices'!A1:J1000", "'Devices'!A1001:J2000", "'Devices'!A2001:J3000"],
  );
  assert.deepEqual(google.sent[1].query, {
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE',
    fields: 'values',
  });
});

test('reads across an empty window and keeps every later device', async () => {
  const total = 3000;
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 1, rowCount: total },
        },
      ]);
    const start = Number(/!A(\d+):/.exec(decodeURIComponent(call.path))[1]) - 1;
    if (start === 0) return valuesAnswer([['Device ID'], ['device-1']]);
    if (start === 1000) return valuesAnswer(undefined);
    return valuesAnswer([['device-last']]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  const read = await collected(tab.rows());
  assert.equal(
    read.length,
    2001,
    'The rows keep the position of the last device.',
  );
  assert.deepEqual(read[0], ['Device ID']);
  assert.deepEqual(read[1], ['device-1']);
  assert.deepEqual(read[1999], [''], 'The gap before the last device is held.');
  assert.deepEqual(read[2000], ['device-last']);
  assert.equal(
    google.sent.filter((call) => call.path.includes('/values/')).length,
    3,
    'An empty window does not end the read.',
  );
});

test('a value after a shortened window keeps its source row', async () => {
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 2, rowCount: 2000 },
        },
      ]);
    const start = Number(/!A(\d+):/.exec(decodeURIComponent(call.path))[1]) - 1;
    return start === 0
      ? valuesAnswer([
          ['Device ID', 'Serial'],
          ['device-1', 'serial-1'],
        ])
      : valuesAnswer([['device-1001', 'serial-1001']]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  assert.deepEqual(
    (await csvRecords(tab.rows())).map((record) => [
      record.row,
      record.cells[0],
    ]),
    [
      [1, 'Device ID'],
      [2, 'device-1'],
      [1001, 'device-1001'],
    ],
  );
});

test('the first nonblank record is the header and blank records keep their rows', async () => {
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 2, rowCount: 6 },
        },
      ]);
    return valuesAnswer([
      [],
      ['Device ID', 'Serial'],
      ['device-1', 'serial-1'],
      [],
      ['device-2', 'serial-2'],
    ]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  assert.deepEqual(await collected(tab.rows()), [
    ['', ''],
    ['Device ID', 'Serial'],
    ['device-1', 'serial-1'],
    ['', ''],
    ['device-2', 'serial-2'],
  ]);
  assert.deepEqual(
    (await csvRecords(tab.rows())).map((record) => [
      record.row,
      record.cells[0],
    ]),
    [
      [2, 'Device ID'],
      [3, 'device-1'],
      [5, 'device-2'],
    ],
  );
});

test('blank records count toward no limit', async () => {
  const total = 51_000;
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 1, rowCount: total },
        },
      ]);
    const start = Number(/!A(\d+):/.exec(decodeURIComponent(call.path))[1]) - 1;
    return valuesAnswer([[start === 0 ? 'Device ID' : `device-${start + 1}`]]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  const read = await collected(tab.rows());
  assert.equal(read.length, 50_001, 'The last record keeps source row 50,001.');
  assert.deepEqual(read[1], [''], 'A blank record counts nowhere.');
  assert.deepEqual(read[50_000], ['device-50001']);
});

test('a value right of the header refuses as ragged-record', async () => {
  const google = fakeDrive((call) =>
    call.path === '/v4/spreadsheets/fixture-sheet'
      ? sheetAnswer([sheetProperties])
      : valuesAnswer([
          ['Device ID', 'Serial'],
          ['device-1', 'serial-1', 'extra'],
        ]),
  );
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleDriveError',
    code: 'ragged-record',
  });
});

test('data row 50,001 refuses as too-many-rows', async () => {
  const total = 50_002;
  const google = fakeDrive((call) => {
    if (call.path === '/v4/spreadsheets/fixture-sheet')
      return sheetAnswer([
        {
          ...sheetProperties,
          gridProperties: { columnCount: 1, rowCount: total },
        },
      ]);
    const start = Number(/!A(\d+):/.exec(decodeURIComponent(call.path))[1]) - 1;
    const first = start === 0 ? [['Device ID']] : [];
    return valuesAnswer([
      ...first,
      ...Array.from(
        {
          length:
            Math.min(GOOGLE_DRIVE_WINDOW_ROWS, total - start) - first.length,
        },
        () => ['device'],
      ),
    ]);
  });
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  let read = 0;
  await assert.rejects(
    (async () => {
      for await (const row of tab.rows()) {
        assert.ok(row.length === 1);
        read += 1;
      }
    })(),
    { name: 'GoogleDriveError', code: 'too-many-rows' },
  );
  assert.equal(read, 50_001, 'The header and 50,000 data rows were read.');
});

for (const contentLength of [true, false])
  test(`a window above 64 MiB refuses as rows-too-large with Content-Length ${
    contentLength ? 'present' : 'absent'
  }`, async () => {
    const size = GOOGLE_DRIVE_WINDOW_BYTES + 1;
    const client = new GoogleDriveClient(
      byteClient(
        () => jsonWindow(size, 4096),
        contentLength
          ? {
              'content-type': 'application/json',
              'content-length': String(size),
            }
          : { 'content-type': 'application/json' },
      ),
      AbortSignal.timeout(30_000),
    );
    const tab = await client.readTab('fixture-sheet', 0);
    await assert.rejects(collected(tab.rows()), {
      name: 'GoogleDriveError',
      code: 'rows-too-large',
    });
  });

test('a window of exactly 64 MiB is read', async () => {
  const size = GOOGLE_DRIVE_WINDOW_BYTES;
  const client = new GoogleDriveClient(
    byteClient(() => jsonWindow(size), {
      'content-type': 'application/json',
      'content-length': String(size),
    }),
    AbortSignal.timeout(30_000),
  );
  const tab = await client.readTab('fixture-sheet', 0);
  const read = await collected(tab.rows());
  assert.equal(read.length, 1);
  assert.equal(
    read[0][0].length,
    size - '{"values":[["'.length - '"]]}'.length,
  );
});

test('the byte cap refuses before the JSON parse', async () => {
  const client = new GoogleDriveClient(
    byteClient(() => rawWindow(GOOGLE_DRIVE_WINDOW_BYTES + 1)),
    AbortSignal.timeout(30_000),
  );
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleDriveError',
    code: 'rows-too-large',
  });
});

test('a window that is not JSON is invalid-response', async () => {
  const client = new GoogleDriveClient(
    byteClient(() => rawWindow(16)),
    AbortSignal.timeout(30_000),
  );
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleConnectionError',
    code: 'invalid-response',
  });
});

test('a values body that resets repeats the same window without duplicate rows', async () => {
  const sleeps = [];
  const { oauth, sent } = streamClient(
    { ...sheetProperties, gridProperties: { columnCount: 1, rowCount: 2000 } },
    (index, url) => {
      const row = Number(/!A(\d+):/.exec(decodeURIComponent(url.pathname))[1]);
      if (row === 1) return jsonBody([['Device ID'], ['device-1']]);
      // The first body of the second window drops after one row, before the JSON closes.
      if (index === 1) return resetWindow('{"values":[["device-1001"');
      return jsonBody([['device-1001']]);
    },
  );
  const client = new GoogleDriveClient(oauth, signal, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 1,
  });
  const tab = await client.readTab('fixture-sheet', 0);
  assert.deepEqual(
    (await csvRecords(tab.rows())).map((record) => [
      record.row,
      record.cells[0],
    ]),
    [
      [1, 'Device ID'],
      [2, 'device-1'],
      [1001, 'device-1001'],
    ],
    'The completed first window is not repeated.',
  );
  assert.deepEqual(windowRanges(sent), [
    "'Devices'!A1:A1000",
    "'Devices'!A1001:A2000",
    "'Devices'!A1001:A2000",
  ]);
  assert.deepEqual(sleeps, [1_000], 'One backoff covers the dropped body.');
});

test('a values body that keeps resetting ends network-failure after five tries', async () => {
  const sleeps = [];
  const { oauth, sent } = streamClient(
    { ...sheetProperties, gridProperties: { columnCount: 1, rowCount: 1 } },
    () => resetWindow('{"values":[['),
  );
  const client = new GoogleDriveClient(oauth, signal, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 1,
  });
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleConnectionError',
    code: 'network-failure',
  });
  assert.deepEqual(
    windowRanges(sent),
    Array.from({ length: 5 }, () => "'Devices'!A1:A1000"),
    'Every try repeats the same range.',
  );
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000]);
});

test('a values answer of another shape is invalid-response', async () => {
  const google = fakeDrive((call) =>
    call.path === '/v4/spreadsheets/fixture-sheet'
      ? sheetAnswer([sheetProperties])
      : ok({ values: 'not rows' }),
  );
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleConnectionError',
    code: 'invalid-response',
  });
});

test('streams the bytes of one file', async () => {
  const google = fakeDrive(() =>
    streamAnswer([Buffer.from('Device ID,Serial\n'), Buffer.from('d1,s1\n')]),
  );
  const client = new GoogleDriveClient(google.client, signal);
  const chunks = await collected(client.stream('fixture-csv'));
  assert.equal(
    Buffer.concat(chunks).toString('utf8'),
    'Device ID,Serial\nd1,s1\n',
  );
  assert.equal(google.sent[0].path, '/drive/v3/files/fixture-csv');
  assert.equal(google.sent[0].query.alt, 'media');
  assert.equal(google.sent[0].responseType, 'stream');
});

test('a stream above 1 GiB refuses as source-too-large', async () => {
  const chunk = new Uint8Array(64 * 1024);
  const google = fakeDrive(() =>
    streamAnswer(
      (function* () {
        for (
          let index = 0;
          index < GOOGLE_DRIVE_SOURCE_BYTES / chunk.length + 1;
          index += 1
        )
          yield chunk;
      })(),
    ),
  );
  const client = new GoogleDriveClient(google.client, signal);
  await assert.rejects(collected(client.stream('fixture-csv')), {
    name: 'GoogleDriveError',
    code: 'source-too-large',
  });
});

test('a quota answer repeats the same read once, then answers', async () => {
  const sleeps = [];
  const google = fakeDrive((call, index) =>
    index === 0
      ? googleError(429, 'rateLimitExceeded')
      : ok({ name: 'Devices.csv', mimeType: 'text/csv' }),
  );
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 1,
  });
  await client.file('fixture-csv');
  assert.equal(google.sent.length, 2);
  assert.equal(google.sent[0].url, google.sent[1].url);
  assert.deepEqual(sleeps, [1_000]);
});

test('a read stops after five tries', async () => {
  const sleeps = [];
  const google = fakeDrive(() => googleError(503, 'backendError'));
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 1,
  });
  await assert.rejects(client.file('fixture-csv'), {
    name: 'GoogleConnectionError',
    code: 'provider-unavailable',
  });
  assert.equal(google.sent.length, 5);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000]);
});

test('a refused read does not repeat', async () => {
  const google = fakeDrive(() => googleError(400, 'badRequest'));
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async () => undefined,
  });
  await assert.rejects(client.file('fixture-csv'), {
    name: 'GoogleConnectionError',
    code: 'request-failed',
  });
  assert.equal(google.sent.length, 1);
});

test('creates one Sheet with the Devices tab and a frozen header row', async () => {
  const google = fakeDrive(() =>
    ok({
      spreadsheetId: 'fixture-spreadsheet',
      sheets: [{ properties: { sheetId: 4, title: 'Devices' } }],
    }),
  );
  const client = new GoogleDriveClient(google.client, signal);
  assert.deepEqual(await client.createSheet('Devices'), {
    spreadsheetId: 'fixture-spreadsheet',
    sheetId: 4,
  });
  assert.equal(google.sent[0].method, 'POST');
  assert.equal(google.sent[0].path, '/v4/spreadsheets');
  assert.equal(google.sent[0].headers['content-type'], 'application/json');
  assert.deepEqual(google.sent[0].body, {
    properties: { title: 'Devices' },
    sheets: [
      {
        properties: {
          title: 'Devices',
          gridProperties: { frozenRowCount: 1 },
        },
      },
    ],
  });
});

test('a lost create answer never repeats', async () => {
  const google = fakeDrive(() => googleError(503, 'backendError'));
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async () => undefined,
  });
  await assert.rejects(client.createSheet('Devices'), {
    name: 'GoogleDriveError',
    code: 'sheet-write-failed',
  });
  assert.equal(google.sent.length, 1);
});

test('a create answer without a spreadsheet ID is sheet-write-failed', async () => {
  const google = fakeDrive(() => ok({}));
  const client = new GoogleDriveClient(google.client, signal);
  await assert.rejects(client.createSheet('Devices'), {
    name: 'GoogleDriveError',
    code: 'sheet-write-failed',
  });
  assert.equal(google.sent.length, 1);
});

test('sets the text number format on every template column', async () => {
  const google = fakeDrive(() => ok({}));
  const client = new GoogleDriveClient(google.client, signal);
  await client.setTextFormat('fixture-spreadsheet', 4, 10);
  assert.equal(
    google.sent[0].path,
    '/v4/spreadsheets/fixture-spreadsheet:batchUpdate',
  );
  assert.equal(google.sent[0].method, 'POST');
  assert.deepEqual(google.sent[0].body, {
    requests: [
      {
        repeatCell: {
          range: {
            sheetId: 4,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: 10,
          },
          cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      },
    ],
  });
});

test('writes rows with RAW values, one thousand rows per call', async () => {
  const google = fakeDrive(() => ok({}));
  const client = new GoogleDriveClient(google.client, signal);
  const written = await client.writeRows(
    'fixture-spreadsheet',
    'Devices',
    2,
    rows(
      ['Device ID', 'Serial'],
      ...Array.from({ length: 1500 }, (_, index) => [
        `device-${index}`,
        `serial-${index}`,
      ]),
    ),
  );
  assert.equal(written, 1501);
  assert.equal(google.sent.length, 2);
  assert.deepEqual(
    google.sent.map((call) => [call.method, call.query]),
    [
      ['PUT', { valueInputOption: 'RAW' }],
      ['PUT', { valueInputOption: 'RAW' }],
    ],
  );
  assert.deepEqual(
    google.sent.map((call) => call.body.range),
    ["'Devices'!A1:B1000", "'Devices'!A1001:B1501"],
  );
  assert.deepEqual(google.sent[0].body.values[0], ['Device ID', 'Serial']);
  assert.deepEqual(google.sent[1].body.values[0], ['device-999', 'serial-999']);
  assert.equal(google.sent[1].body.values.length, 501);
  assert.equal(google.sent[0].body.majorDimension, 'ROWS');
});

test('a values update repeats the same range after a 5xx answer', async () => {
  const sleeps = [];
  const google = fakeDrive((call, index) =>
    index < 2 ? googleError(503, 'backendError') : ok({}),
  );
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    random: () => 1,
  });
  await client.writeRows('fixture-spreadsheet', 'Devices', 1, rows(['a']));
  assert.equal(google.sent.length, 3);
  assert.deepEqual(
    google.sent.map((call) => [decodeURIComponent(call.path), call.body]),
    Array.from({ length: 3 }, () => [
      "/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1:A1",
      { range: "'Devices'!A1:A1", majorDimension: 'ROWS', values: [['a']] },
    ]),
  );
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test('a values update that keeps failing ends sheet-write-failed', async () => {
  const google = fakeDrive(() => googleError(503, 'backendError'));
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async () => undefined,
  });
  await assert.rejects(
    client.writeRows('fixture-spreadsheet', 'Devices', 1, rows(['a'])),
    { name: 'GoogleDriveError', code: 'sheet-write-failed' },
  );
  assert.equal(google.sent.length, 5);
});

test('a refused values update does not repeat', async () => {
  const google = fakeDrive(() => googleError(400, 'badRequest'));
  const client = new GoogleDriveClient(google.client, signal, {
    sleep: async () => undefined,
  });
  await assert.rejects(
    client.writeRows('fixture-spreadsheet', 'Devices', 1, rows(['a'])),
    { name: 'GoogleDriveError', code: 'sheet-write-failed' },
  );
  assert.equal(google.sent.length, 1);
});

test('a row of another width is a caller defect', async () => {
  const google = fakeDrive(() => ok({}));
  const client = new GoogleDriveClient(google.client, signal);
  await assert.rejects(
    client.writeRows('fixture-spreadsheet', 'Devices', 2, rows(['a'])),
    TypeError,
  );
  assert.equal(google.sent.length, 0);
});

test('column letters follow the A1 notation', () => {
  assert.deepEqual([1, 10, 26, 27, 52, 53, 702, 703].map(columnName), [
    'A',
    'J',
    'Z',
    'AA',
    'AZ',
    'BA',
    'ZZ',
    'AAA',
  ]);
});

test('only a *.test.mjs file names the fake transport', () => {
  const roots = [
    'libs',
    'packages',
    'api/src',
    'worker/src',
    'frontend/src',
    'deployment',
    'api-e2e',
    'frontend-e2e',
  ];
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules') continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:ts|mjs|cjs|js)$/.test(name)) continue;
      if (readFileSync(path, 'utf8').includes('drive-fake.mjs'))
        found.push(path);
    }
  };
  for (const root of roots) walk(root);
  const outside = found.filter((path) => !path.endsWith('.test.mjs'));
  assert.deepEqual(
    outside,
    [],
    'every file that names the fake transport ends with .test.mjs',
  );
  assert.ok(
    found.includes('libs/google-connection/src/lib/drive.test.mjs'),
    'the guard test itself names the fake transport',
  );
});
