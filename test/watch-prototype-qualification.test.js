import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../fixtures/watch-transfer.espruino', import.meta.url), 'utf8');
const DEFAULT_CALL = "})('filename', 'unique-host-generated-id', 48);";
function run(input, { name = 'file.bin', id = 'test-id', size = 48, mutateRead } = {}) {
  const output = [];
  let readCount = 0;
  const storage = { read(file, offset, length) {
    assert.equal(file, name);
    readCount++;
    return mutateRead ? mutateRead(input, offset, length, readCount) : input.subarray(offset, offset + length).toString('latin1');
  } };
  const configured = source.replace(DEFAULT_CALL, `})(${JSON.stringify(name)}, ${JSON.stringify(id)}, ${size});`);
  assert.notEqual(configured, source);
  runInNewContext(configured, { require: name => { assert.equal(name, 'Storage'); return storage; }, print: line => output.push(line), String, Error, JSON, Math, Object });
  const prefix = `@@BANGLESYNC/1:${id}:`, suffix = ':END@@';
  const records = output.map(line => {
    assert.ok(line.startsWith(prefix) && line.endsWith(suffix));
    return JSON.parse(line.slice(prefix.length, -suffix.length));
  });
  return { records, readCount };
}

function referenceCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

test('watch Base64 and CRC implementations qualify against known vectors and binary bytes', () => {
  const vectors = [Buffer.from('123456789'), Buffer.from([0, 255, 254, 1, 128, 127])];
  for (const bytes of vectors) {
    const { records } = run(bytes, { size: 48 });
    const chunks = records.filter(x => x.kind === 'chunk');
    assert.deepEqual(Buffer.concat(chunks.map(x => Buffer.from(x.payload, 'base64'))), bytes);
    assert.equal(chunks[0]?.crc32, referenceCrc32(bytes));
  }
  assert.equal(referenceCrc32(Buffer.from('123456789')), 'cbf43926');
});

test('watch handles empty input and final partial chunks with bounded reads', () => {
  const empty = run(Buffer.alloc(0));
  assert.deepEqual(empty.records.map(x => x.kind), ['start', 'end']);
  const bytes = Buffer.from(Array.from({ length: 101 }, (_, i) => i));
  const { records } = run(bytes, { size: 48 });
  const chunks = records.filter(x => x.kind === 'chunk');
  assert.deepEqual(chunks.map(x => x.length), [48, 48, 5]);
  assert.ok(chunks.every(x => x.length <= 48));
  assert.deepEqual(Buffer.concat(chunks.map(x => Buffer.from(x.payload, 'base64'))), bytes);
});

test('watch reports missing files and files whose length changes after sizing', () => {
  const missing = run(Buffer.alloc(0), { mutateRead: () => undefined });
  assert.equal(missing.records.at(-1).kind, 'error');
  const bytes = Buffer.from('first pass');
  const changed = run(bytes, { mutateRead(input, offset, length, count) {
    if (count > 1) return 'x'.repeat(length - 1);
    return input.subarray(offset, offset + length).toString('latin1');
  } });
  assert.equal(changed.records.at(-1).kind, 'error');
});

test('watch validates filename and transfer parameters before reading', () => {
  assert.throws(() => run(Buffer.alloc(0), { name: 'bad\nname' }), /Invalid Storage filename/);
  assert.throws(() => run(Buffer.alloc(0), { id: 'bad:id' }), /Invalid transfer identifier/);
  assert.throws(() => run(Buffer.alloc(0), { size: 49 }), /Invalid chunk size/);
});
