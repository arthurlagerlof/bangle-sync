import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransfer } from '../src/transfer-protocol.js';
import { encodeReplFrame, ReplFrameReceiver, simulateReplResponse } from '../src/repl-framing.js';

const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const options = { transferId: 'repl-id', name: 'all.bin', type: 'ordinary', totalLength: data.length };
const frames = [...encodeTransfer({ ...options, data, chunkSize: 40 })];
const split = text => Array.from({ length: text.length }, (_, i) => text.slice(i, i + 1));

test('REPL framing handles echoes, prompts, diagnostics, partial lines and split/concatenated frames', async () => {
  const wire = `\n${frames.map(encodeReplFrame).join('> ')}\nDIAG: unrelated\n`;
  const result = await simulateReplResponse(frames, options, { transform: split });
  assert.equal(result.size, data.length);
  const rx = new ReplFrameReceiver(options);
  let complete;
  for (const piece of [wire.slice(0, 19), wire.slice(19, 213), wire.slice(213)]) complete = await rx.push(piece) ?? complete;
  rx.finish();
  assert.equal(complete.sha256, frames.at(-1).sha256);
});

test('REPL rejects stale IDs, malformed protocol lines, incomplete response and disconnect', async () => {
  const old = encodeReplFrame({ ...frames[0], transferId: 'old-id' });
  const staleRx = new ReplFrameReceiver(options);
  await assert.rejects(staleRx.push(old), /Stale/);
  const malformedRx = new ReplFrameReceiver(options);
  await assert.rejects(malformedRx.push('@@BANGLESYNC/1:repl-id:partial@@\n'), /malformed/);
  const partialRx = new ReplFrameReceiver(options);
  await partialRx.push(encodeReplFrame(frames[0]));
  assert.throws(() => partialRx.finish(), /Incomplete/);
  const disconnected = new ReplFrameReceiver(options);
  disconnected.onDisconnect();
  await assert.rejects(disconnected.push('late\n'), /disconnect/);
});

test('REPL detects partial protocol lines and oversized lines', async () => {
  const rx = new ReplFrameReceiver({ ...options, maxLineLength: 50 });
  await assert.rejects(rx.push('x'.repeat(51)), /exceeded limit/);
  const partial = new ReplFrameReceiver(options);
  await partial.push('@@BANGLESYNC/1:repl-id:broken');
  assert.throws(() => partial.finish(), /Partial REPL line/);
});
