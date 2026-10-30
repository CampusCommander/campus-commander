import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_DRIVE_SOURCE_BYTES,
  GOOGLE_DRIVE_WINDOW_BYTES,
  GOOGLE_DRIVE_WINDOW_ROWS,
  GOOGLE_SHEET_MIME_TYPE,
  GoogleDriveClient,
  columnName,
  personDriveClient,
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

const rows = (...items) => items;
const ok = (data) => ({ status: 200, data });

/** Collect an async iterable into an array. */
async function collected(source) {
  const items = [];
  for await (const item of source) items.push(item);
  return items;
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
    if (options.responseType === 'stream')
      return {
        status: 200,
        headers: new Headers(),
        data: Readable.from([Buffer.from('a,b\n')]),
      };
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
  assert.ok(sent.length >= 7);
  const authorization = `Bearer ${mintedToken}`;
  assert.deepEqual(
    sent.map((item) => item.authorization),
    Array.from({ length: sent.length }, () => authorization),
  );
  assert.deepEqual(
    sent.filter((item) => item.path.includes('/values/')).length,
    2,
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
  assert.equal(read.length, 1003);
  assert.deepEqual(read[0], ['Device ID', 'Serial']);
  assert.deepEqual(
    read[1],
    ['device-1', ''],
    'A short row pads to the header.',
  );
  assert.deepEqual(read[1002], ['device-last', 'serial-last']);
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

test('a values answer above 64 MiB refuses as rows-too-large', async () => {
  const google = fakeDrive((call) =>
    call.path === '/v4/spreadsheets/fixture-sheet'
      ? sheetAnswer([sheetProperties])
      : ok({ values: [['x'.repeat(GOOGLE_DRIVE_WINDOW_BYTES)]] }),
  );
  const client = new GoogleDriveClient(google.client, signal);
  const tab = await client.readTab('fixture-sheet', 0);
  await assert.rejects(collected(tab.rows()), {
    name: 'GoogleDriveError',
    code: 'rows-too-large',
  });
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
    'api/src',
    'worker/src',
    'frontend/src',
    'deployment',
    'api-e2e',
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
  assert.deepEqual(found, ['libs/google-connection/src/lib/drive.test.mjs']);
});
