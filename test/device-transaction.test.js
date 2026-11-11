import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');

function fakeAdapter(initial, { rejectNextNewCommit = false, rejectRestore = false, corruptStage = false } = {}) {
  const files = new Map([['trial.app.js', Buffer.from(initial)]]), writes = [];
  const storage = {
    read(name, offset = 0, length = 0) {
      const bytes = files.get(name);
      return bytes === undefined ? undefined : bytes.subarray(offset, length > 0 ? offset + length : undefined).toString('latin1');
    },
    readArrayBuffer(name) {
      const bytes = files.get(name);
      if (bytes === undefined) return undefined;
      const copy = Buffer.from(bytes);
      if (corruptStage && name.startsWith('bss-t-')) copy[0] ^= 1;
      return Uint8Array.from(copy).buffer;
    },
    open() { return null; },
    erase(name) { files.delete(name); },
    write(name, text, offset = 0, size = 0) {
      const bytes = Buffer.from(text, 'latin1');
      writes.push({ name, offset, size, length: bytes.length });
      if (rejectNextNewCommit && name === 'trial.app.js' && offset === 0 && bytes[0] === 0xA5) {
        rejectNextNewCommit = false;
        const partial = Buffer.alloc(size || bytes.length, 0xFF);
        bytes.subarray(0, Math.min(24, bytes.length)).copy(partial);
        files.set(name, partial);
        return false;
      }
      if (rejectRestore && name === 'trial.app.js' && offset === 0 && bytes[0] !== 0xA5) return false;
      let target = files.get(name);
      if (offset === 0) {
        target = Buffer.alloc(size || bytes.length, 0xFF);
        files.set(name, target);
      }
      if (!target || offset + bytes.length > target.length) return false;
      bytes.copy(target, offset);
      return true;
    }
  };
  const adapter = new EspruinoCliAdapter({
    ownership: { 'trial.app.js': 'app:trial' },
    knownFiles: ['trial.app.js'],
    inlineFiles: ['trial.app.js']
  });
  adapter.child = {};
  adapter.closed = false;
  adapter._request = async expression => runInNewContext(expression, { require: () => storage, Uint8Array, global: {} });
  return { adapter, files, writes };
}

const update = (adapter, prior, next, onState = () => {}) => adapter.write('trial.app.js', next, {
  owner: 'app:trial', action: 'update', backupVerified: true,
  expectedSize: next.length, expectedSha256: sha256(next), expectedPreviousSha256: sha256(prior), onState
});

test('physical update uses verified stage and recovery copy with correct chunk offsets', async () => {
  const prior = Buffer.from(Array.from({ length: 777 }, (_, i) => i & 255));
  const next = Buffer.from(Array.from({ length: 1103 }, (_, i) => (0xA5 + i) & 255));
  const { adapter, files, writes } = fakeAdapter(prior);
  const states = [];
  await update(adapter, prior, next, state => states.push(state));
  assert.deepEqual(files.get('trial.app.js'), next);
  assert.equal(files.size, 1);
  assert.deepEqual(states, ['staging', 'staged', 'verified', 'committing', 'committed']);
  for (const name of new Set(writes.map(write => write.name))) {
    const offsets = writes.filter(write => write.name === name).map(write => write.offset);
    assert.equal(offsets[0], 0);
    offsets.forEach((offset, index) => assert.equal(offset, index * 192));
  }
  assert.deepEqual(writes.filter(write => write.name === 'trial.app.js').map(write => write.offset), [0, 192, 384, 576, 768, 960]);
});

test('failed commit restores the previous verified file and reports failure', async () => {
  const prior = Buffer.from('previous verified app bytes');
  const next = Buffer.alloc(900, 0xA5);
  const { adapter, files } = fakeAdapter(prior, { rejectNextNewCommit: true });
  const states = [];
  await assert.rejects(update(adapter, prior, next, state => states.push(state)), error => {
    assert.equal(error.transferState, 'failed');
    assert.equal(error.recoveryRequired, false);
    assert.match(error.message, /Previous verified destination was restored/);
    return true;
  });
  assert.deepEqual(files.get('trial.app.js'), prior);
  assert.equal(files.size, 1);
  assert.equal(states.at(-1), 'failed');
});

test('staged read-back hash mismatch never reaches commit', async () => {
  const prior = Buffer.from('previous verified app bytes');
  const next = Buffer.alloc(900, 0xA5);
  const { adapter, files, writes } = fakeAdapter(prior, { corruptStage: true });
  const states = [];
  await assert.rejects(update(adapter, prior, next, state => states.push(state)), /Staged payload failed/);
  assert.deepEqual(files.get('trial.app.js'), prior);
  assert.equal(writes.some(write => write.name === 'trial.app.js'), false);
  assert.equal(states.at(-1), 'partially-written');
});

test('failed rollback reports recovery-required and keeps the verified recovery copy', async () => {
  const prior = Buffer.from('previous verified app bytes');
  const next = Buffer.alloc(900, 0xA5);
  const { adapter, files } = fakeAdapter(prior, { rejectNextNewCommit: true, rejectRestore: true });
  await assert.rejects(update(adapter, prior, next), error => {
    assert.equal(error.transferState, 'recovery-required');
    assert.equal(error.recoveryRequired, true);
    assert.match(error.message, /verified previous bytes remain/);
    return true;
  });
  assert.notDeepEqual(files.get('trial.app.js'), prior);
  assert.equal([...files.keys()].some(name => name.startsWith('bss-r-')), true);
});

test('invalid expected payload metadata is rejected before any Storage write', async () => {
  const { adapter, writes } = fakeAdapter(Buffer.from('unchanged'));
  await assert.rejects(adapter.write('trial.app.js', Buffer.from('wrong'), {
    owner: 'app:trial', action: 'update', backupVerified: true,
    expectedSize: 99, expectedSha256: '0'.repeat(64), expectedPreviousSha256: sha256(Buffer.from('unchanged'))
  }), /expected size or SHA-256/);
  assert.equal(writes.length, 0);
});
