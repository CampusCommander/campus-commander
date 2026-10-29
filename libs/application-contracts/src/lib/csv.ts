/**
 * The RFC 4180 reader and writer of the device export and import
 * (`docs/research/batch-update-export-import-technical-design.md`, sections 6.4 and 9.2).
 *
 * This module holds no I/O and no device rule. The worker streams a stored file through the
 * reader, and the export streams records out of the writer. The reader refuses a file that the
 * contract cannot read: an open quote, a misplaced quote, a ragged record, or a cell past the
 * cell limit.
 */

/** The byte order mark of an exported file (section 6.4). */
export const CSV_BYTE_ORDER_MARK = '\uFEFF';

/** The record end of an exported file. The reader accepts LF as well (section 9.2). */
export const CSV_RECORD_END = '\r\n';

/** The cell limit of a file (section 9.2). A longer cell refuses the file. The count is code
 * points, as the device field limits count them. */
export const CSV_MAX_CELL_LENGTH = 16384;

/** The four faults that stop a file before any row check (section 9.2). A quote outside its
 * RFC 4180 place refuses the file, so a malformed cell never turns into another writable value. */
export const CSV_ERROR_CODES = [
  'unterminated-quote',
  'malformed-quote',
  'ragged-record',
  'cell-too-long',
] as const;
export type CsvErrorCode = (typeof CSV_ERROR_CODES)[number];

/** A refused file. The code names the fault; the caller answers the refusal text. */
export class CsvError extends Error {
  readonly code: CsvErrorCode;
  constructor(code: CsvErrorCode) {
    super(`The CSV file holds a fault: ${code}.`);
    this.name = 'CsvError';
    this.code = code;
  }
}

/** One logical record of a file. */
export interface CsvRecord {
  /** The 1-based line where the record starts. A quoted cell may span lines. */
  line: number;
  /** The cell text of the record, unquoted and unescaped. */
  cells: string[];
}

export interface CsvReader {
  /** Feed one decoded chunk. It answers every record that the chunk completed. */
  push(chunk: string): CsvRecord[];
  /** Finish the file. It answers the last record, or refuses an open quote. */
  end(): CsvRecord[];
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;

/**
 * An incremental RFC 4180 reader. A chunk may split any character pair, any CRLF pair, and any
 * quoted cell. A byte order mark at the start of the file is dropped. A blank record is dropped
 * and counts nowhere (section 9.2). The first record that it answers sets the column count, and a
 * later record with another count refuses the file.
 */
export function createCsvReader(): CsvReader {
  let line = 1;
  let recordLine = 1;
  let cells: string[] = [];
  let field = '';
  let fieldLength = 0;
  let recordStarted = false;
  let quoted = false;
  let quoteClosed = false;
  let skipLineFeed = false;
  let width: number | null = null;
  let pending = '';
  let firstChunk = true;

  function endField(): void {
    cells.push(field);
    field = '';
    fieldLength = 0;
    quoteClosed = false;
  }

  function endRecord(out: CsvRecord[]): void {
    endField();
    const record: CsvRecord = { line: recordLine, cells };
    const blank = record.cells.every((cell) => cell.trim() === '');
    cells = [];
    recordStarted = false;
    quoted = false;
    quoteClosed = false;
    if (blank) return;
    if (width === null) width = record.cells.length;
    else if (record.cells.length !== width) throw new CsvError('ragged-record');
    out.push(record);
  }

  function startRecord(): void {
    if (recordStarted) return;
    recordStarted = true;
    recordLine = line;
  }

  function countCell(): void {
    fieldLength += 1;
    if (fieldLength > CSV_MAX_CELL_LENGTH) throw new CsvError('cell-too-long');
  }

  function read(text: string, out: CsvRecord[]): void {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const code = text.charCodeAt(index);
      if (skipLineFeed) {
        skipLineFeed = false;
        // The second half of a CRLF pair. The record end already advanced the line.
        if (char === '\n') continue;
      }
      if (quoted) {
        if (char === '"') {
          quoted = false;
          quoteClosed = true;
          continue;
        }
        if (char === '\n') line += 1;
        field += char;
        // A low surrogate closes the pair that its high surrogate opened.
        if (code < LOW_SURROGATE_FIRST || code > 0xdfff) countCell();
        continue;
      }
      if (quoteClosed) {
        if (char === '"') {
          // A doubled quote is one literal quote inside the quoted cell.
          field += '"';
          quoted = true;
          quoteClosed = false;
          countCell();
          continue;
        }
        if (char === ',') {
          endField();
          startRecord();
          continue;
        }
        if (char === '\r' || char === '\n') {
          // Fall through to the record end below.
        } else {
          // RFC 4180 allows no text between a closing quote and the next comma or record end.
          throw new CsvError('malformed-quote');
        }
      }
      if (char === ',') {
        endField();
        startRecord();
        continue;
      }
      if (char === '\r' || char === '\n') {
        endRecord(out);
        if (char === '\r') skipLineFeed = true;
        line += 1;
        continue;
      }
      if (char === '"') {
        // A quote opens a cell only as its first character. Anywhere else it is a fault.
        if (field !== '') throw new CsvError('malformed-quote');
        startRecord();
        quoted = true;
        continue;
      }
      startRecord();
      field += char;
      if (code < LOW_SURROGATE_FIRST || code > 0xdfff) countCell();
    }
  }

  return {
    push(chunk: string): CsvRecord[] {
      const out: CsvRecord[] = [];
      let text = pending + chunk;
      pending = '';
      if (firstChunk && text.length > 0) {
        firstChunk = false;
        if (text.startsWith(CSV_BYTE_ORDER_MARK))
          text = text.slice(CSV_BYTE_ORDER_MARK.length);
      }
      if (text.length > 0) {
        const last = text.charCodeAt(text.length - 1);
        if (last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST) {
          // Hold the half pair, so the next chunk completes it.
          pending = text.at(-1) ?? '';
          text = text.slice(0, -1);
        }
      }
      read(text, out);
      return out;
    },
    end(): CsvRecord[] {
      const out: CsvRecord[] = [];
      if (pending !== '') {
        const last = pending;
        pending = '';
        read(last, out);
      }
      if (quoted) throw new CsvError('unterminated-quote');
      if (recordStarted) endRecord(out);
      return out;
    },
  };
}

/** One cell in RFC 4180 form. A comma, a quote, or a line end quotes the cell. */
export function csvCellText(cell: string): string {
  if (!/[",\r\n]/.test(cell)) return cell;
  return `"${cell.replaceAll('"', '""')}"`;
}

/** One record in RFC 4180 form, with its record end. */
export function csvRecordText(cells: readonly string[]): string {
  return `${cells.map(csvCellText).join(',')}${CSV_RECORD_END}`;
}

const encoder = new TextEncoder();

/** The UTF-8 byte count of a text. The export stops at its cap on this count. */
export function csvTextBytes(text: string): number {
  return encoder.encode(text).length;
}

export interface CsvWriter {
  /** The first text of a file: the byte order mark. It counts once. */
  start(): string;
  /** One record, in RFC 4180 form with its record end. */
  row(cells: readonly string[]): string;
  /** The UTF-8 bytes that the writer answered. */
  readonly bytes: number;
  /** The records that the writer answered, the header included. */
  readonly rows: number;
}

/** A record writer that counts its UTF-8 bytes and its records (section 6.4). */
export function createCsvWriter(): CsvWriter {
  let bytes = 0;
  let rows = 0;
  return {
    start(): string {
      bytes += csvTextBytes(CSV_BYTE_ORDER_MARK);
      return CSV_BYTE_ORDER_MARK;
    },
    row(cells: readonly string[]): string {
      const text = csvRecordText(cells);
      bytes += csvTextBytes(text);
      rows += 1;
      return text;
    },
    get bytes(): number {
      return bytes;
    },
    get rows(): number {
      return rows;
    },
  };
}
