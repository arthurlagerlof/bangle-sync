import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransfer, simulateTransfer, TransferReceiver } from '../src/transfer-protocol.js';

const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const options = { name: 'binary.bin', data, transferId: 'test-id', chunkSize: 31 };

test('protocol round-trips empty, all-byte-values, NUL, and large payloads exactly', async () => {
  for (const sample of [Buffer.alloc(0), data, Buffer.alloc(2_000_000, 0), Buffer.alloc(1_000_000, 0xa5)]) {
    const result = await simulateTransfer({ ...options, data: sample });
    assert.deepEqual(result.data, sample);
  }
});

test('protocol detects missing, duplicate, reordered, corrupt, truncated, and invalid end frames', async () => {
  const frames = [...encodeTransfer(options)];
  const mutations = [
    f => f.filter((_, i) => i !== 1),
    f => [f[0], f[0], ...f.slice(1)],
    f => [f[1], f[0], ...f.slice(2)],
    f => f.map((x, i) => i === 0 ? { ...x, payload: 'AA==' } : x),
    f => f.map((x, i) => i === 0 ? { ...x, crc32: '00000000' } : x),
    f => f.slice(0, -1),
    f => [...f.slice(0, -1), { ...f.at(-1), totalLength: 99 }],
    f => [...f.slice(0, -1), { ...f.at(-1), sha256: '0'.repeat(64) }]
  ];
  for (const mutate of mutations) await assert.rejects(simulateTransfer(options, { mutate }));
});

test('protocol checks CRC before passing bytes to the sink', async () => {
  const frames = [...encodeTransfer(options)];
  let accepted = 0;
  const receiver = new TransferReceiver({
    transferId: options.transferId, name: options.name, type: 'ordinary', totalLength: data.length,
    onChunk: async () => { accepted++; }
  });
  await assert.rejects(receiver.accept({ ...frames[0], crc32: '00000000' }), /CRC-32/);
  assert.equal(accepted, 0);
});

test('protocol enforces timeout, cancellation, maximum size, and declared length', async () => {
  await assert.rejects(simulateTransfer(options, { receiverOptions: { maxLength: 1 } }), /Invalid or excessive/);
  await assert.rejects(simulateTransfer(options, { receiverOptions: { timeoutMs: 1, now: (() => { let n = 0; return () => n++ ? 3 : 0; })() } }), /timed out/);
  await assert.rejects(simulateTransfer(options, { signal: { aborted: true } }), /cancelled/);
  await assert.rejects(simulateTransfer(options, { mutate: f => f.map((x, i) => i === 0 ? { ...x, totalLength: 2 } : x) }));
});
