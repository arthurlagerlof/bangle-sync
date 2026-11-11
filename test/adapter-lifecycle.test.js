import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';

const deviceId = 'aa:bb:cc:dd:ee:ff';

function reconnectAdapter({ discoveries = [], failures = 0 } = {}) {
  const delays = [], events = [];
  const adapter = new EspruinoCliAdapter({ sleep: async ms => { delays.push(ms); } });
  adapter.deviceId = deviceId;
  adapter.disconnect = async () => { events.push('disconnect'); adapter.child = null; adapter.closed = true; adapter.deviceId = null; };
  adapter.discover = async () => {
    events.push('discover');
    return discoveries.shift() ?? [{ id: deviceId }];
  };
  adapter._connectOnce = async id => {
    events.push(`connect:${id}`);
    if (failures-- > 0) throw new Error('EspruinoTools subprocess disconnected during handshake.');
    adapter.deviceId = id; adapter.child = {}; adapter.closed = false;
    return { connected: true, userApi: 'Bangle.js' };
  };
  return { adapter, delays, events };
}

test('physical discovery explains when the optional EspruinoTools CLI is missing', async () => {
  const adapter = new EspruinoCliAdapter({ resolveCli: () => null });
  await assert.rejects(adapter.discover(), /EspruinoTools is optional and is not installed/);
});

test('discovery retries transient no-port results and then succeeds', async () => {
  const { adapter, delays } = reconnectAdapter();
  delete adapter.discover;
  let attempts = 0;
  adapter._discoverOnce = async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('scan failed'), { stderr: 'No Ports Found' });
    return [{ id: deviceId }];
  };
  assert.deepEqual(await adapter.discover(), [{ id: deviceId }]);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('discovery shares concurrent scan requests', async () => {
  const { adapter } = reconnectAdapter();
  delete adapter.discover;
  let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  adapter._discoverOnce = async () => { attempts++; await gate; return [{ id: deviceId }]; };
  const first = adapter.discover(), second = adapter.discover();
  release();
  const results = await Promise.all([first, second]);
  assert.equal(attempts, 1);
  assert.deepEqual(results[0], results[1]);
});

test('reconnect rediscovers the same selected device before connecting', async () => {
  const { adapter, delays, events } = reconnectAdapter();
  const result = await adapter._reconnect();
  assert.equal(result.connected, true);
  assert.deepEqual(events, ['disconnect', 'discover', `connect:${deviceId}`]);
  assert.deepEqual(delays, [250]);
  assert.equal(adapter.deviceId, deviceId);
});

test('reconnect retries discovery and transport failures with bounded backoff', async () => {
  const { adapter, delays, events } = reconnectAdapter({ discoveries: [[], [{ id: deviceId }], [{ id: deviceId }]], failures: 1 });
  const result = await adapter._reconnect();
  assert.equal(result.connected, true);
  assert.deepEqual(delays, [250, 500, 1000]);
  assert.equal(events.filter(item => item === 'discover').length, 3);
  assert.equal(events.filter(item => item.startsWith('connect:')).length, 2);
});

test('connection retries rediscovery after a failed transport handshake', async () => {
  const { adapter, delays, events } = reconnectAdapter({ discoveries: [[{ id: deviceId }]], failures: 1 });
  const result = await adapter.connect(deviceId);
  assert.equal(result.connected, true);
  assert.deepEqual(delays, [500]);
  assert.equal(events.filter(item => item === 'discover').length, 1);
  assert.equal(events.filter(item => item.startsWith('connect:')).length, 2);
});

test('reconnect fails clearly after bounded attempts when the selected device is absent', async () => {
  const { adapter, delays, events } = reconnectAdapter({ discoveries: [[], [], []] });
  await assert.rejects(adapter._reconnect(), /failed after 3 attempts:.*not rediscovered/i);
  assert.deepEqual(delays, [250, 500, 1000]);
  assert.equal(events.filter(item => item === 'discover').length, 3);
  assert.equal(adapter.deviceId, null);
});

test('parallel reconnect requests share one discovery and connection attempt', async () => {
  const { adapter, events } = reconnectAdapter();
  const results = await Promise.all([adapter._reconnect(), adapter._reconnect()]);
  assert.equal(results.length, 2);
  assert.equal(events.filter(item => item === 'discover').length, 1);
  assert.equal(events.filter(item => item.startsWith('connect:')).length, 1);
});

test('disconnect finalizes streams after subprocess exit even if close is delayed', async () => {
  const adapter = new EspruinoCliAdapter();
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.killed = false;
  child.stdin = { destroyed: false, end() { setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, 5); }, destroy() { this.destroyed = true; } };
  child.stdout = { destroyed: false, destroy() { this.destroyed = true; } };
  child.stderr = { destroyed: false, destroy() { this.destroyed = true; } };
  child.kill = () => true;
  adapter.child = child; adapter.closed = false; adapter.deviceId = deviceId;
  await adapter.disconnect();
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(adapter.deviceId, null);
});

test('parallel disconnect requests wait for the same subprocess close', async () => {
  const adapter = new EspruinoCliAdapter();
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.killed = false;
  child.stdin = { end() { setTimeout(() => { child.exitCode = 0; child.emit('close', 0); }, 5); } };
  child.kill = () => { child.killed = true; child.signalCode = 'SIGTERM'; setTimeout(() => child.emit('close', null), 5); return true; };
  adapter.child = child; adapter.closed = false; adapter.deviceId = deviceId;
  await Promise.all([adapter.disconnect(), adapter.disconnect()]);
  assert.equal(adapter.child, null);
  assert.equal(adapter.deviceId, null);
  assert.equal(adapter.closed, true);
});
