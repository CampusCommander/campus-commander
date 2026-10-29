import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CSV_BYTE_ORDER_MARK,
  CSV_MAX_CELL_LENGTH,
  CSV_RECORD_END,
  CsvError,
  createCsvReader,
  createCsvWriter,
  csvCellText,
  csvRecordText,
  csvTextBytes,
} from './csv.ts';

const readAll = (chunks) => {
  const reader = createCsvReader();
  const records = [];
  for (const chunk of chunks) records.push(...reader.push(chunk));
  records.push(...reader.end());
  return records;
};

const faultOf = (chunks) => {
  try {
    readAll(chunks);
  } catch (error) {
    assert.ok(error instanceof CsvError, `A CsvError, not ${error}`);
    return error.code;
  }
  return null;
};

test('a byte order mark and CRLF records read as the template header and its rows', () => {
  const text =
    CSV_BYTE_ORDER_MARK +
    'Device ID,Serial number,Status\r\n' +
    '04XTBHJ,C0A1-7F2D,DISABLED\r\n' +
    '02A1MB6,C0A1-7F2E,ACTIVE\r\n';
  assert.deepEqual(readAll([text]), [
    { line: 1, cells: ['Device ID', 'Serial number', 'Status'] },
    { line: 2, cells: ['04XTBHJ', 'C0A1-7F2D', 'DISABLED'] },
    { line: 3, cells: ['02A1MB6', 'C0A1-7F2E', 'ACTIVE'] },
  ]);
  // A byte order mark inside a cell stays a cell character.
  assert.deepEqual(readAll(['a,\uFEFFb\n']), [
    { line: 1, cells: ['a', '\uFEFFb'] },
  ]);
});

test('LF record ends read the same records as CRLF', () => {
  assert.deepEqual(readAll(['a,b\nc,d\n']), [
    { line: 1, cells: ['a', 'b'] },
    { line: 2, cells: ['c', 'd'] },
  ]);
  // A last record without a line end still reads.
  assert.deepEqual(readAll(['a,b\nc,d']), [
    { line: 1, cells: ['a', 'b'] },
    { line: 2, cells: ['c', 'd'] },
  ]);
});

test('quoted cells keep commas, quotes, and line feeds', () => {
  const text = '"a,b","say ""hi""","line one\nline two",plain\r\n';
  assert.deepEqual(readAll([text]), [
    { line: 1, cells: ['a,b', 'say "hi"', 'line one\nline two', 'plain'] },
  ]);
  // The line of the next record counts the lines inside a quoted cell.
  assert.deepEqual(readAll([text, 'w,x,y,z\r\n']), [
    { line: 1, cells: ['a,b', 'say "hi"', 'line one\nline two', 'plain'] },
    { line: 3, cells: ['w', 'x', 'y', 'z'] },
  ]);
});

test('any chunk split reads the same records', () => {
  const text =
    CSV_BYTE_ORDER_MARK +
    'Device ID,Notes\r\n' +
    '04XTBHJ,"Loaner, cart 3\r\nreturns ""Friday"""\r\n' +
    '02A1MB6,repaired\r\n';
  const whole = readAll([text]);
  assert.equal(whole.length, 3);
  for (let split = 0; split <= text.length; split += 1) {
    assert.deepEqual(
      readAll([text.slice(0, split), text.slice(split)]),
      whole,
      `split at ${split}`,
    );
  }
  // One character at a time, including the halves of the CRLF pair and the doubled quote.
  const perCharacter = Array.from(text);
  assert.deepEqual(readAll(perCharacter), whole);
});

test('a chunk split inside a surrogate pair keeps the character whole', () => {
  const text = 'Device ID,Notes\r\n04XTBHJ,Chromebook 😀 cart\r\n';
  const at = text.indexOf('😀') + 1;
  assert.deepEqual(readAll([text.slice(0, at), text.slice(at)]), [
    { line: 1, cells: ['Device ID', 'Notes'] },
    { line: 2, cells: ['04XTBHJ', 'Chromebook 😀 cart'] },
  ]);
  // A lone high surrogate at the end of the file stays a cell character.
  assert.deepEqual(readAll(['a,\uD83D']), [
    { line: 1, cells: ['a', '\uD83D'] },
  ]);
});

test('the first record sets the column count and a ragged record refuses the file', () => {
  assert.equal(faultOf(['a,b\nc,d\ne,f,g\n']), 'ragged-record');
  assert.equal(faultOf(['a,b\nc\n']), 'ragged-record');
  // A blank row counts nowhere, so it never reads as a ragged record.
  assert.deepEqual(readAll(['a,b\n\n  ,  \nc,d\n']), [
    { line: 1, cells: ['a', 'b'] },
    { line: 4, cells: ['c', 'd'] },
  ]);
});

test('an open quote refuses the file', () => {
  assert.equal(faultOf(['a,b\n"c,d\n']), 'unterminated-quote');
  assert.equal(faultOf(['a,b\nc,"d']), 'unterminated-quote');
  assert.equal(faultOf(['a,b\nc,"d""']), 'unterminated-quote');
});

test('a quote outside its RFC 4180 place refuses the file', () => {
  // Text after a closing quote would otherwise change the cell text.
  const afterClose = 'Device ID,Notes\r\nexample-device,"North"lab"\r\n';
  assert.equal(faultOf([afterClose]), 'malformed-quote');
  // A quote inside an unquoted cell is not literal text either.
  const insideUnquoted = 'Device ID,Notes\r\nexample-device,North"lab\r\n';
  assert.equal(faultOf([insideUnquoted]), 'malformed-quote');
  // Every chunk split refuses the same way and answers no record first.
  for (const text of [afterClose, insideUnquoted]) {
    for (let split = 0; split <= text.length; split += 1) {
      assert.equal(
        faultOf([text.slice(0, split), text.slice(split)]),
        'malformed-quote',
        `split at ${split}`,
      );
    }
    assert.equal(faultOf(Array.from(text)), 'malformed-quote');
  }
  // A quote after a space of an unquoted cell is outside its place too.
  assert.equal(faultOf(['a, "b"\n']), 'malformed-quote');
  // A doubled quote, a quoted line feed, and a quoted comma still read.
  assert.deepEqual(readAll(['"x""y","line one\nline two"\n']), [
    { line: 1, cells: ['x"y', 'line one\nline two'] },
  ]);
});

test('the cell limit counts code points and refuses a longer cell', () => {
  const longest = 'x'.repeat(CSV_MAX_CELL_LENGTH);
  assert.deepEqual(readAll([`a,${longest}\n`]), [
    { line: 1, cells: ['a', longest] },
  ]);
  assert.equal(faultOf([`a,${longest}x\n`]), 'cell-too-long');
  // A quoted cell counts the same way, and the quotes stay out of the count.
  assert.equal(faultOf([`a,"${longest}x"\n`]), 'cell-too-long');
  assert.deepEqual(readAll([`a,"${longest}"\n`]), [
    { line: 1, cells: ['a', longest] },
  ]);
  // One astral character is one code point and two UTF-16 units.
  const astral = '😀'.repeat(CSV_MAX_CELL_LENGTH);
  assert.equal(
    readAll([`a,${astral}\n`])[0].cells[1].length,
    2 * CSV_MAX_CELL_LENGTH,
  );
  assert.equal(faultOf([`a,${astral}😀\n`]), 'cell-too-long');
});

test('the writer quotes a cell that holds a comma, a quote, or a line end', () => {
  assert.equal(csvCellText('plain'), 'plain');
  assert.equal(csvCellText('a,b'), '"a,b"');
  assert.equal(csvCellText('say "hi"'), '"say ""hi"""');
  assert.equal(csvCellText('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCellText('carriage\rreturn'), '"carriage\rreturn"');
  assert.equal(csvCellText(''), '');
  assert.equal(csvRecordText(['a', 'b,c']), 'a,"b,c"\r\n');
  assert.equal(CSV_RECORD_END, '\r\n');
});

test('the writer counts its UTF-8 bytes and its records', () => {
  const writer = createCsvWriter();
  assert.equal(writer.start(), CSV_BYTE_ORDER_MARK);
  assert.equal(writer.bytes, 3);
  assert.equal(writer.rows, 0);
  writer.row(['Device ID', 'Notes']);
  writer.row(['04XTBHJ', 'café']);
  // 9 + 1 + 5 + 2 = 17 bytes for the header, and 7 + 1 + 5 + 2 = 15 bytes for the row.
  assert.equal(csvTextBytes('Device ID,Notes\r\n'), 17);
  assert.equal(csvTextBytes('04XTBHJ,café\r\n'), 15);
  assert.equal(writer.bytes, 3 + 17 + 15);
  assert.equal(writer.rows, 2);
  // A written file reads back through the reader.
  assert.deepEqual(
    readAll([CSV_BYTE_ORDER_MARK, 'Device ID,Notes\r\n04XTBHJ,café\r\n']),
    [
      { line: 1, cells: ['Device ID', 'Notes'] },
      { line: 2, cells: ['04XTBHJ', 'café'] },
    ],
  );
});

test('a written record round-trips every RFC 4180 hazard', () => {
  const cells = ['a,b', 'say "hi"', 'line one\nline two', 'plain', ''];
  assert.deepEqual(readAll([csvRecordText(cells)]), [{ line: 1, cells }]);
});

test('an empty file reads as no record', () => {
  assert.deepEqual(readAll(['']), []);
  assert.deepEqual(readAll([CSV_BYTE_ORDER_MARK]), []);
  assert.deepEqual(readAll(['\r\n\r\n']), []);
});
