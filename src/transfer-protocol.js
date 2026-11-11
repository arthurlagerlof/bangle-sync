import { createHash, randomUUID } from 'node:crypto';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
};

export function* encodeTransfer({ name, type = 'ordinary', data, transferId = randomUUID(), chunkSize = 768 }) {
  if (!Buffer.isBuffer(data) || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new TypeError('data must be a Buffer and chunkSize a positive integer');
  if (typeof name !== 'string' || !name || !['ordinary', 'storage'].includes(type) || typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(transferId)) throw new TypeError('Invalid file metadata');
  const common = { transferId, name, type, totalLength: data.length };
  for (let offset = 0, sequence = 0; offset < data.length; offset += chunkSize, sequence++) {
    const bytes = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    yield { kind: 'chunk', ...common, sequence, offset, encoding: 'base64', payload: bytes.toString('base64'), crc32: crc32(bytes), chunkSha256: sha256(bytes) };
  }
  yield { kind: 'end', ...common, chunks: Math.ceil(data.length / chunkSize), sha256: sha256(data) };
}

export class TransferReceiver {
  constructor({ transferId, name, type, totalLength, maxLength = Number.MAX_SAFE_INTEGER, maxChunkLength = 768, timeoutMs = 30000, onChunk = async () => {}, now = () => Date.now() }) {
    if (typeof transferId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(transferId) || typeof name !== 'string' || !['ordinary', 'storage'].includes(type) || !Number.isSafeInteger(totalLength) || totalLength < 0 || totalLength > maxLength) throw new TypeError('Invalid or excessive transfer metadata');
    this.meta = { transferId, name, type, totalLength };
    this.maxChunkLength = maxChunkLength; this.timeoutMs = timeoutMs; this.onChunk = onChunk; this.now = now;
    this.startedAt = now(); this.offset = 0; this.sequence = 0; this.hash = createHash('sha256'); this.done = false; this.cancelled = false;
  }
  async accept(frame) {
    if (this.done || this.cancelled) throw new Error('Transfer is no longer active');
    if (this.now() - this.startedAt > this.timeoutMs) { this.cancel(); throw new Error('Transfer timed out'); }
    for (const key of Object.keys(this.meta)) if (frame?.[key] !== this.meta[key]) throw new Error(`Frame metadata mismatch: ${key}`);
    if (frame.kind === 'chunk') {
      if (frame.sequence !== this.sequence || frame.offset !== this.offset) throw new Error('Missing, duplicate, or reordered chunk');
      if (frame.encoding !== 'base64' || typeof frame.payload !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.payload)) throw new Error('Invalid base64 payload');
      const bytes = Buffer.from(frame.payload, 'base64');
      if (bytes.length === 0 || bytes.length > this.maxChunkLength || bytes.toString('base64') !== frame.payload || this.offset + bytes.length > this.meta.totalLength) throw new Error('Invalid chunk length or encoding');
      if (typeof frame.crc32 !== 'string' || !/^[a-f0-9]{1,8}$/.test(frame.crc32) || crc32(bytes) !== frame.crc32) throw new Error('Chunk CRC-32 check failed');
      if (!validHash(frame.chunkSha256) || sha256(bytes) !== frame.chunkSha256) throw new Error('Chunk SHA-256 check failed');
      await this.onChunk(bytes, this.offset);
      this.hash.update(bytes); this.offset += bytes.length; this.sequence++;
      return { complete: false };
    }
    if (frame.kind !== 'end') throw new Error('Unknown frame kind');
    if (this.offset !== this.meta.totalLength || frame.chunks !== this.sequence || !validHash(frame.sha256) || this.hash.digest('hex') !== frame.sha256) throw new Error('End marker length, count, or whole-file hash mismatch');
    this.done = true;
    return { complete: true, size: this.offset, sha256: frame.sha256, chunks: this.sequence };
  }
  cancel() { this.cancelled = true; }
}

export async function simulateTransfer(options, { mutate = frames => frames, receiverOptions = {}, signal } = {}) {
  const frames = [...encodeTransfer(options)];
  const chunks = [];
  const receiver = new TransferReceiver({ transferId: frames[0]?.transferId ?? options.transferId, name: options.name, type: options.type ?? 'ordinary', totalLength: options.data.length, onChunk: async bytes => { chunks.push(Buffer.from(bytes)); }, ...receiverOptions });
  for (const frame of mutate(frames)) {
    if (signal?.aborted) { receiver.cancel(); throw new Error('Transfer cancelled'); }
    const result = await receiver.accept(frame);
    if (result.complete) {
      const output = Buffer.concat(chunks);
      if (!output.equals(options.data)) throw new Error('Reassembled bytes differ from source');
      return { ...result, data: output };
    }
  }
  throw new Error('Transfer ended without a valid end marker');
}
