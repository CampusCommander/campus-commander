import type { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  DEVICE_IMPORT_ROW_LIMIT,
  googleDriveFileIdSchema,
  googleDriveTabIdSchema,
  googleDriveTabListSchema,
  type GoogleDriveTabList,
} from '@campus/application-contracts';
import { failure, GoogleConnectionError, scopedClient } from './provider';
import type { DelegatedCredential } from './credential';

/**
 * The Drive v3 and Sheets v4 calls of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, sections 4, 6, and 7).
 *
 * Every call runs as the signed-in person, with one `drive.file` token that the session names the
 * subject of. The client reads file metadata, the media stream, the tabs of a Sheet, and its value
 * windows. It writes one Sheet, its text format, and its values. It holds no setting that points it
 * at a test double: tests pass a fake transport through the constructor.
 */

/** The only scope of a Drive or Sheets call (design section 4). */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4';

/** The file type of a Google Sheet (design section 1). */
export const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

/** The tab of an exported Sheet (design section 6). */
export const GOOGLE_SHEET_TAB_TITLE = 'Devices';

/** A values window holds 1,000 rows (design section 7). */
export const GOOGLE_DRIVE_WINDOW_ROWS = 1000;

/** A values answer holds at most 64 MiB (design section 7). */
export const GOOGLE_DRIVE_WINDOW_BYTES = 64 * 1024 * 1024;

/** A Drive file holds at most 1 GiB (design section 7). */
export const GOOGLE_DRIVE_SOURCE_BYTES = 1024 * 1024 * 1024;

/** A read or a values update tries at most five times (design sections 6 and 7). */
export const GOOGLE_DRIVE_ATTEMPTS = 5;

/** Google's column limit of one Sheet tab. */
const COLUMN_LIMIT = 18278;

/** The transport limit. The client counts each values answer and each media stream itself. */
const transportLimit = GOOGLE_DRIVE_SOURCE_BYTES + 1;

/** The Drive and Sheets conditions that a Google failure code does not name. */
export const GOOGLE_DRIVE_ERROR_CODES = [
  /** Google answered 403 or 404 for the file (design section 7). */
  'drive-file-unavailable',
  /** The chosen file is not a Google Sheet (design section 1). */
  'not-a-sheet',
  /** The Sheet holds no tab with the chosen ID (design section 1). */
  'tab-missing',
  /** The media stream passes 1 GiB (design section 7). */
  'source-too-large',
  /** One values answer passes 64 MiB (design section 7). */
  'rows-too-large',
  /** The tab holds data row 50,001 (design section 7). */
  'too-many-rows',
  /** A row holds a value right of the header (design section 7). */
  'ragged-record',
  /** A Sheets write failed (design section 6). */
  'sheet-write-failed',
] as const;
export type GoogleDriveErrorCode = (typeof GOOGLE_DRIVE_ERROR_CODES)[number];

export class GoogleDriveError extends Error {
  readonly code: GoogleDriveErrorCode;

  constructor(code: GoogleDriveErrorCode) {
    super(code);
    this.name = 'GoogleDriveError';
    this.code = code;
  }
}

/** One file, as the Drive import reads its facts (design section 7). */
export interface GoogleDriveFile {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  /** The byte size. A Google Sheet holds none. */
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
}

/** One Sheet tab and its lazily read rows (design section 7). */
export interface GoogleDriveTabValues {
  readonly fileId: string;
  readonly tabId: number;
  /** The current title of the tab, as `spreadsheets.get` answers it. */
  readonly title: string;
  /** The rows of the tab, the header first, each padded to the header width. */
  rows(): AsyncIterable<string[]>;
}

/** The Sheet that `spreadsheets.create` made (design section 6). */
export interface GoogleDriveSheet {
  readonly spreadsheetId: string;
  readonly sheetId: number;
}

export interface GoogleDriveHttpResponse {
  status?: number;
  headers?: unknown;
  data: unknown;
}

/** The only client surface the Drive client uses. `OAuth2Client` satisfies it. */
export interface GoogleDriveHttpClient {
  request(options: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT';
    params?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    /** The JSON text of a write body. The client serializes every write. */
    body?: string;
    responseType?: 'json' | 'stream';
  }): Promise<GoogleDriveHttpResponse>;
}

export interface GoogleDriveClientOptions {
  /** Wait for a backoff delay. Resolve early, without throwing, when the signal aborts. */
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
  /** A number from 0 up to 1, for full jitter. */
  random?(): number;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

interface DriveClock {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  random(): number;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const fileResponse = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .optional(),
  modifiedTime: z.iso.datetime({ offset: true }).optional(),
});

const sheetProperties = z.object({
  sheetId: z.number().int().min(0),
  title: z.string().min(1).max(255),
  index: z.number().int().min(0),
  gridProperties: z
    .object({
      columnCount: z.number().int().min(1).max(COLUMN_LIMIT),
      rowCount: z.number().int().min(1).max(10_000_000),
    })
    .optional(),
});
const sheetResponse = z.object({
  sheets: z
    .array(z.object({ properties: sheetProperties }))
    .min(1)
    .max(1000),
});

const valuesResponse = z.object({
  values: z
    .array(z.array(z.string().nullable()))
    .max(GOOGLE_DRIVE_WINDOW_ROWS)
    .optional(),
});

const createdSheet = z.object({
  spreadsheetId: googleDriveFileIdSchema,
  sheets: z
    .array(z.object({ properties: z.object({ sheetId: z.number().int() }) }))
    .min(1),
});

/** Read one answer against its schema. A shape that contradicts the contract is a Google failure. */
function parsed<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new GoogleConnectionError('invalid-response');
  return result.data;
}

/** Read the HTTP status of a failed Google call. */
function responseStatus(error: unknown): number | undefined {
  const result = z
    .object({ response: z.object({ status: z.number() }).optional() })
    .safeParse(error);
  return result.success ? result.data.response?.status : undefined;
}

/** The Google conditions that a retry can clear (design sections 6 and 7). */
function retryable(error: unknown): boolean {
  const code = failure(error).code;
  return (
    code === 'quota' ||
    code === 'provider-unavailable' ||
    code === 'network-failure'
  );
}

/** A1 notation quotes a title with apostrophes. An apostrophe inside doubles. */
function quoteTitle(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

/** The A1 column name of a 1-based column count: 1 is A, 27 is AA. */
export function columnName(columns: number): string {
  let name = '';
  for (let value = columns; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * The Drive and Sheets calls of one person. The client mints one `drive.file` token for the
 * subject through `personDriveClient`, and sends it on every call.
 */
export class GoogleDriveClient {
  private readonly http: GoogleDriveHttpClient;
  private readonly signal: AbortSignal;
  private readonly clock: DriveClock;

  constructor(
    http: GoogleDriveHttpClient,
    signal: AbortSignal,
    options: GoogleDriveClientOptions = {},
  ) {
    this.http = http;
    this.signal = signal;
    this.clock = {
      sleep: options.sleep ?? abortableSleep,
      random: options.random ?? Math.random,
      maxAttempts: options.maxAttempts ?? GOOGLE_DRIVE_ATTEMPTS,
      initialDelayMs: options.initialDelayMs ?? 1_000,
      maxDelayMs: options.maxDelayMs ?? 8_000,
    };
  }

  /** Full jitter over an exponential ceiling. `attempt` is 1 for the first retry. */
  private delay(attempt: number): number {
    const ceiling = Math.min(
      this.clock.maxDelayMs,
      this.clock.initialDelayMs * 2 ** (attempt - 1),
    );
    return Math.floor(this.clock.random() * ceiling);
  }

  /** Send one call, repeating a quota answer, a 5xx answer, or a network fault. */
  private async send(
    options: Parameters<GoogleDriveHttpClient['request']>[0],
    attempts: number,
  ): Promise<GoogleDriveHttpResponse> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.http.request(options);
      } catch (error) {
        if (
          error instanceof GoogleDriveError ||
          error instanceof GoogleConnectionError
        )
          throw error;
        if (attempt >= attempts || this.signal.aborted || !retryable(error))
          throw error;
        await this.clock.sleep(this.delay(attempt), this.signal);
        if (this.signal.aborted) throw error;
      }
    }
  }

  /** A GET that answers JSON. A missing file or a lost grant is `drive-file-unavailable`. */
  private async read(
    url: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<unknown> {
    try {
      return (
        await this.send({ url, method: 'GET', params }, this.clock.maxAttempts)
      ).data;
    } catch (error) {
      if (
        error instanceof GoogleDriveError ||
        error instanceof GoogleConnectionError
      )
        throw error;
      const status = responseStatus(error);
      if (status === 403 || status === 404)
        throw new GoogleDriveError('drive-file-unavailable');
      throw failure(error);
    }
  }

  /** A POST or PUT whose failure is `sheet-write-failed` (design section 6). */
  private async write(
    url: string,
    method: 'POST' | 'PUT',
    body: unknown,
    attempts: number,
    params?: Record<string, string | number | boolean>,
  ): Promise<unknown> {
    try {
      return (
        await this.send(
          {
            url,
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            params,
          },
          attempts,
        )
      ).data;
    } catch (error) {
      if (error instanceof GoogleDriveError) throw error;
      throw new GoogleDriveError('sheet-write-failed');
    }
  }

  /** Read the metadata of one file, as the person (design section 7). */
  async file(fileId: string): Promise<GoogleDriveFile> {
    googleDriveFileIdSchema.parse(fileId);
    const data = await this.read(`${GOOGLE_DRIVE_API}/files/${fileId}`, {
      fields: 'id,name,mimeType,size,modifiedTime',
    });
    const answer = parsed(fileResponse, data);
    const sizeBytes = answer.size === undefined ? null : Number(answer.size);
    if (sizeBytes !== null && !Number.isSafeInteger(sizeBytes))
      throw new GoogleConnectionError('invalid-response');
    return {
      fileId,
      name: answer.name,
      mimeType: answer.mimeType,
      sizeBytes,
      modifiedAt: answer.modifiedTime ?? null,
    };
  }

  /** Read the metadata of one file as the tabs route needs it. */
  private async sheetData(
    fileId: string,
    fields: string,
  ): Promise<z.infer<typeof sheetResponse>> {
    const data = await this.read(
      `${GOOGLE_SHEETS_API}/spreadsheets/${fileId}`,
      {
        fields,
      },
    );
    return parsed(sheetResponse, data);
  }

  /** List the tabs of one Sheet (design section 1). */
  async tabs(fileId: string): Promise<GoogleDriveTabList> {
    googleDriveFileIdSchema.parse(fileId);
    const file = await this.file(fileId);
    if (file.mimeType !== GOOGLE_SHEET_MIME_TYPE)
      throw new GoogleDriveError('not-a-sheet');
    const answer = await this.sheetData(
      fileId,
      'sheets(properties(sheetId,title,index))',
    );
    return googleDriveTabListSchema.parse({
      fileId,
      tabs: answer.sheets.map((sheet) => ({
        tabId: sheet.properties.sheetId,
        title: sheet.properties.title,
        index: sheet.properties.index,
      })),
    });
  }

  /** Open one tab: its current title, and its rows (design section 7). */
  async readTab(fileId: string, tabId: number): Promise<GoogleDriveTabValues> {
    googleDriveFileIdSchema.parse(fileId);
    googleDriveTabIdSchema.parse(tabId);
    const answer = await this.sheetData(
      fileId,
      'sheets(properties(sheetId,title,index,gridProperties(columnCount,rowCount)))',
    );
    const sheet = answer.sheets.find(
      (item) => item.properties.sheetId === tabId,
    );
    if (!sheet) throw new GoogleDriveError('tab-missing');
    const grid = sheet.properties.gridProperties;
    if (!grid) throw new GoogleConnectionError('invalid-response');
    const title = sheet.properties.title;
    return {
      fileId,
      tabId,
      title,
      rows: () => this.tabRows(fileId, title, grid.columnCount, grid.rowCount),
    };
  }

  /** One values window, padded to the header width by `tabRows`. */
  private async valuesWindow(
    fileId: string,
    title: string,
    start: number,
    columns: number,
  ): Promise<string[][]> {
    const range = `${quoteTitle(title)}!A${start + 1}:${columnName(columns)}${
      start + GOOGLE_DRIVE_WINDOW_ROWS
    }`;
    const data = await this.read(
      `${GOOGLE_SHEETS_API}/spreadsheets/${fileId}/values/${encodeURIComponent(
        range,
      )}`,
      {
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE',
        fields: 'values',
      },
    );
    // The 64 MiB cap reads the JSON text of the answer, before any row is built (design section 7).
    if (
      Buffer.byteLength(JSON.stringify(data), 'utf8') >
      GOOGLE_DRIVE_WINDOW_BYTES
    )
      throw new GoogleDriveError('rows-too-large');
    const answer = parsed(valuesResponse, data);
    return (answer.values ?? []).map((row) => row.map((cell) => cell ?? ''));
  }

  /**
   * Read the windows of one tab in row order. Each row pads to the header width. A value right of
   * the header refuses as `ragged-record`, and data row 50,001 refuses as `too-many-rows`.
   */
  private async *tabRows(
    fileId: string,
    title: string,
    columns: number,
    total: number,
  ): AsyncIterable<string[]> {
    let headerWidth = 0;
    let dataRows = 0;
    for (let start = 0; start < total; start += GOOGLE_DRIVE_WINDOW_ROWS) {
      const window = await this.valuesWindow(fileId, title, start, columns);
      for (const [offset, row] of window.entries()) {
        if (start === 0 && offset === 0) headerWidth = row.length;
        if (row.length > headerWidth)
          throw new GoogleDriveError('ragged-record');
        const padded =
          row.length === headerWidth
            ? row
            : [...row, ...Array<string>(headerWidth - row.length).fill('')];
        if (start !== 0 || offset !== 0) {
          dataRows += 1;
          if (dataRows > DEVICE_IMPORT_ROW_LIMIT)
            throw new GoogleDriveError('too-many-rows');
        }
        yield padded;
      }
    }
  }

  /** Stream the bytes of one file, `files.get` with `alt=media` (design section 7). */
  async *stream(fileId: string): AsyncIterable<Uint8Array> {
    googleDriveFileIdSchema.parse(fileId);
    let response: GoogleDriveHttpResponse;
    try {
      response = await this.send(
        {
          url: `${GOOGLE_DRIVE_API}/files/${fileId}`,
          method: 'GET',
          params: { alt: 'media' },
          responseType: 'stream',
        },
        this.clock.maxAttempts,
      );
    } catch (error) {
      if (
        error instanceof GoogleDriveError ||
        error instanceof GoogleConnectionError
      )
        throw error;
      const status = responseStatus(error);
      if (status === 403 || status === 404)
        throw new GoogleDriveError('drive-file-unavailable');
      throw failure(error);
    }
    const body = response.data;
    if (
      typeof body !== 'object' ||
      body === null ||
      !(Symbol.asyncIterator in body)
    )
      throw new GoogleConnectionError('invalid-response');
    let bytes = 0;
    for await (const chunk of body as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array))
        throw new GoogleConnectionError('invalid-response');
      bytes += chunk.byteLength;
      if (bytes > GOOGLE_DRIVE_SOURCE_BYTES)
        throw new GoogleDriveError('source-too-large');
      yield chunk;
    }
  }

  /**
   * Make one Sheet with the Devices tab and a frozen header row (design section 6). A lost answer
   * leaves a second Sheet, so this call never repeats.
   */
  async createSheet(title: string): Promise<GoogleDriveSheet> {
    const name = z.string().min(1).max(255).parse(title);
    const data = await this.write(
      `${GOOGLE_SHEETS_API}/spreadsheets`,
      'POST',
      {
        properties: { title: name },
        sheets: [
          {
            properties: {
              title: GOOGLE_SHEET_TAB_TITLE,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        ],
      },
      1,
    );
    const answer = parsed(createdSheet, data);
    return {
      spreadsheetId: answer.spreadsheetId,
      sheetId: answer.sheets[0].properties.sheetId,
    };
  }

  /** Set the text number format of every template column (design section 6). */
  async setTextFormat(
    spreadsheetId: string,
    sheetId: number,
    columns: number,
  ): Promise<void> {
    googleDriveFileIdSchema.parse(spreadsheetId);
    z.number().int().min(0).parse(sheetId);
    z.number().int().min(1).max(COLUMN_LIMIT).parse(columns);
    await this.write(
      `${GOOGLE_SHEETS_API}/spreadsheets/${spreadsheetId}:batchUpdate`,
      'POST',
      {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                startColumnIndex: 0,
                endColumnIndex: columns,
              },
              cell: {
                userEnteredFormat: { numberFormat: { type: 'TEXT' } },
              },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
      1,
    );
  }

  /**
   * Write rows with `RAW` values, 1,000 rows per call in row order (design section 6). A 429, a 5xx,
   * or a lost answer repeats the same range, because the same values are idempotent.
   */
  async writeRows(
    spreadsheetId: string,
    title: string,
    columns: number,
    rows: AsyncIterable<readonly string[]>,
  ): Promise<number> {
    googleDriveFileIdSchema.parse(spreadsheetId);
    const tab = z.string().min(1).max(255).parse(title);
    const width = z.number().int().min(1).max(COLUMN_LIMIT).parse(columns);
    let start = 0;
    let chunk: string[][] = [];
    for await (const row of rows) {
      if (row.length !== width)
        throw new TypeError(`A row holds ${row.length} cells, not ${width}.`);
      chunk.push([...row]);
      if (chunk.length === GOOGLE_DRIVE_WINDOW_ROWS) {
        await this.updateValues(spreadsheetId, tab, width, start, chunk);
        start += chunk.length;
        chunk = [];
      }
    }
    if (chunk.length > 0)
      await this.updateValues(spreadsheetId, tab, width, start, chunk);
    return start + chunk.length;
  }

  /** One `values.update` call over one range. */
  private async updateValues(
    spreadsheetId: string,
    title: string,
    columns: number,
    start: number,
    values: string[][],
  ): Promise<void> {
    const range = `${quoteTitle(title)}!A${start + 1}:${columnName(columns)}${
      start + values.length
    }`;
    await this.write(
      `${GOOGLE_SHEETS_API}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
        range,
      )}`,
      'PUT',
      { range, majorDimension: 'ROWS', values },
      this.clock.maxAttempts,
      { valueInputOption: 'RAW' },
    );
  }
}

/**
 * Mint one `drive.file` token for the person and answer the client of their Drive and Sheets calls
 * (design section 4). The subject comes from the server session, never from a request.
 */
export async function personDriveClient(
  credential: DelegatedCredential,
  subject: string,
  signal: AbortSignal,
  options: GoogleDriveClientOptions = {},
): Promise<GoogleDriveClient> {
  const person = z.email().max(254).parse(subject);
  const client: OAuth2Client = await scopedClient(
    { ...credential, subject: person },
    GOOGLE_DRIVE_SCOPE,
    signal,
    transportLimit,
  );
  return new GoogleDriveClient(client, signal, options);
}
