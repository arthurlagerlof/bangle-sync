import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../fixtures/watch-transfer.espruino', import.meta.url), 'utf8');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

test('watch-side fixture reads bounded chunks and emits binary-safe, checksummed frames in a mock only', () => {
  const input = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const calls = [], output = [];
  const storage = { read(name, offset, length) { calls.push({ name, offset, length }); return input.subarray(offset, offset + length).toString('latin1'); }, write() { throw new Error('write forbidden'); } };
  runInNewContext(source, { require: name => { assert.equal(name, 'Storage'); return storage; }, print: line => output.push(line), Math, String, Error, JSON, Object });
  const records = output.map(line => {
    const prefix = '@@BANGLESYNC/1:unique-host-generated-id:';
    assert.ok(line.startsWith(prefix) && line.endsWith(':END@@'));
    return JSON.parse(line.slice(prefix.length, -':END@@'.length));
  });
  assert.equal(records[0].kind, 'start');
  assert.equal(records[0].totalLength, input.length);
  const dataFrames = records.filter(record => record.kind === 'chunk');
  assert.equal(Buffer.concat(dataFrames.map(frame => Buffer.from(frame.payload, 'base64'))).equals(input), true);
  for (const frame of dataFrames) {
    const bytes = Buffer.from(frame.payload, 'base64');
    assert.equal(frame.length, bytes.length);
    assert.equal(frame.crc32, crc32(bytes));
    assert.ok(bytes.length <= 48);
  }
  assert.deepEqual(records.at(-1), { kind: 'end', transferId: 'unique-host-generated-id', totalLength: input.length, chunks: dataFrames.length });
  assert.equal(records.at(-1).totalLength, input.length);
  assert.equal(createHash('sha256').update(Buffer.concat(dataFrames.map(frame => Buffer.from(frame.payload, 'base64')))).digest('hex').length, 64);
  assert.ok(calls.every(call => call.length <= 48));
});
