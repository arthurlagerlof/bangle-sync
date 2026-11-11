import { TransferReceiver } from './transfer-protocol.js';

const PREFIX = '@@BANGLESYNC/1:';
const SUFFIX = ':END@@';
export function encodeReplFrame(frame) {
  const json = Buffer.from(JSON.stringify(frame), 'utf8').toString('base64');
  return `${PREFIX}${frame.transferId}:${json}${SUFFIX}\n`;
}

export class ReplFrameReceiver {
  constructor(options) {
    this.transferId = options.transferId;
    this.maxLineLength = options.maxLineLength ?? 8192;
    this.line = '';
    this.frames = 0;
    this.disconnect = false;
    this.receiver = new TransferReceiver(options);
  }
  async push(text) {
    if (this.disconnect) throw new Error('Unexpected disconnect');
    if (typeof text !== 'string') throw new TypeError('REPL input must be decoded ASCII/UTF-8 text');
    this.line += text;
    if (this.line.length > this.maxLineLength && !this.line.includes('\n')) throw new Error('REPL line exceeded limit');
    const lines = this.line.split('\n'); this.line = lines.pop();
    let completed = null;
    for (const raw of lines) {
      const line = raw.trim().replace(/^(?:>\s*)+/, '');
      if (!line.startsWith(PREFIX)) continue; // echoes, prompts and diagnostics are not protocol records
      if (!line.endsWith(SUFFIX)) throw new Error('Partial or malformed REPL protocol frame');
      const body = line.slice(PREFIX.length, -SUFFIX.length);
      const separator = body.indexOf(':');
      if (separator < 1) throw new Error('Malformed REPL protocol envelope');
      const id = body.slice(0, separator);
      if (id !== this.transferId) throw new Error('Stale or unexpected transfer identifier');
      let frame;
      try {
        const encoded = body.slice(separator + 1);
        const bytes = Buffer.from(encoded, 'base64');
        if (!encoded || bytes.toString('base64') !== encoded) throw new Error();
        frame = JSON.parse(bytes.toString('utf8'));
      } catch { throw new Error('Invalid REPL protocol payload'); }
      if (frame.transferId !== id) throw new Error('Envelope/frame transfer identifier mismatch');
      const result = await this.receiver.accept(frame);
      this.frames++;
      if (result.complete) completed = result;
    }
    return completed;
  }
  finish() {
    if (this.line.trim()) throw new Error('Partial REPL line at response end');
    if (!this.receiver.done) throw new Error('Incomplete REPL response');
  }
  onDisconnect() { this.disconnect = true; this.receiver.cancel(); }
}

export async function simulateReplResponse(frames, options, { transform = chunks => chunks, receiverOptions = {} } = {}) {
  const receiver = new ReplFrameReceiver({ ...options, ...receiverOptions });
  let result = null;
  for (const part of transform(frames.map(encodeReplFrame).join(''))) result = await receiver.push(part) ?? result;
  receiver.finish();
  if (!result) throw new Error('No completed REPL transfer');
  return result;
}
