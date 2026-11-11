import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, unlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedDevice, createBackup, verifyBackup, safeName, planDeployment, deploy, planHash } from '../src/core.js';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';

test('simulated backup and independent verification preserve exact binary bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-backup-'));
  const samples = [Buffer.alloc(0), Buffer.from([0, 1, 127, 128, 254, 255]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.alloc(100000, 0xa5)];
  const device = new SimulatedDevice(Object.fromEntries(samples.map((b, i) => [`file${i}`, b])));
  try {
    const backup = await createBackup(device, root);
    assert.equal(backup.manifest.complete, true);
    for (let i = 0; i < samples.length; i++) assert.deepEqual(await readFile(join(backup.dir, 'ordinary', `file${i}`)), samples[i]);
    assert.equal((await verifyBackup(backup.dir)).complete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('StorageFiles containing firmware end marker cannot qualify as complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-backup-'));
  const d = new SimulatedDevice({}); d.files.set('sf', Buffer.from([1, 255, 2]));
  d.inventory = async () => [{ name: 'sf', storageFile: true, size: 3 }];
  try { const b = await createBackup(d, root); assert.equal(b.manifest.complete, false); assert.equal((await verifyBackup(b.dir)).complete, false); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('filename traversal is rejected and deployment requires explicit confirmation', async () => {
  assert.equal(safeName('../x'), false); assert.equal(safeName('.boot0'), true);
  const root = await mkdtemp(join(tmpdir(), 'bangle-deploy-'));
  try {
    const source = join(root, 'source.bin'); await writeFile(source, Buffer.from([0, 255]));
    const d = new SimulatedDevice(); const plan = await planDeployment(d, [{ source, target: 'app.bin' }]);
    const partial = new SimulatedDevice({}); partial.files.set('unsafe-sf', Buffer.from([255]));
    partial.inventory = async () => [{ name: 'unsafe-sf', storageFile: true, size: 1 }];
    const backup = await createBackup(partial, join(root, 'backups'));
    await assert.rejects(deploy(d, plan), /--confirm/);
    await assert.rejects(deploy(d, plan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(plan), workspaceRoot: root }), /outside the workspace/);
    await assert.rejects(deploy(d, plan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(plan) }), /incomplete or invalid/);
    d.files.set('existing.bin', Buffer.from('before'));
    const freshPlan = await planDeployment(d, [{ source, target: 'app2.bin' }]);
    const validBackup = await createBackup(d, join(root, 'backups'));
    assert.equal((await deploy(d, freshPlan, { confirm: true, backupDirectory: validBackup.dir, approvedPlanHash: planHash(freshPlan) })).complete, true);
    assert.equal((await d.read('app2.bin')).toString('hex'), '00ff');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('independent verifier detects missing, corrupt, and unmanifested backup files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-check-'));
  try {
    const b = await createBackup(new SimulatedDevice({ 'a.bin': Buffer.from('payload') }), root);
    const file = join(b.dir, 'ordinary', 'a.bin');
    await writeFile(file, Buffer.from('corrupt'));
    assert.equal((await verifyBackup(b.dir)).complete, false);
    await writeFile(file, Buffer.from('payload'));
    await writeFile(join(b.dir, 'ordinary', 'extra'), Buffer.from('extra'));
    assert.equal((await verifyBackup(b.dir)).complete, false);
    await unlink(join(b.dir, 'ordinary', 'extra'));
    await unlink(file);
    assert.equal((await verifyBackup(b.dir)).complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup records interrupted transfers and files changing during transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-fail-'));
  try {
    const d = new SimulatedDevice({ change: Buffer.from('one'), broken: Buffer.from('x') });
    const originalRead = d.read.bind(d); let changeCalls = 0;
    d.read = async (name, options) => {
      if (name === 'broken') throw new Error('simulated interrupted transfer');
      if (name === 'change' && ++changeCalls > 1) return Buffer.from('two');
      return originalRead(name, options);
    };
    const b = await createBackup(d, root);
    assert.equal(b.manifest.complete, false);
    assert.deepEqual(b.manifest.files.map(x => x.status), ['failed', 'failed']);
    assert.equal((await verifyBackup(b.dir)).complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('inventory mutation makes backup incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-race-'));
  try {
    const d = new SimulatedDevice({ a: Buffer.from('a') }); let scans = 0;
    const inventory = d.inventory.bind(d);
    d.inventory = async () => { scans++; if (scans === 2) d.files.set('added', Buffer.from('b')); return inventory(); };
    const b = await createBackup(d, root);
    assert.equal(b.manifest.inventoryChanged, true);
    assert.equal(b.manifest.complete, false);
    assert.equal((await verifyBackup(b.dir)).complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployment rejects overwrite, mapping collisions, protected files and stale approvals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-gates-'));
  try {
    const source = join(root, 'src'); await writeFile(source, Buffer.from('new'));
    const d = new SimulatedDevice({ existing: Buffer.from('old') });
    await assert.rejects(planDeployment(d, [{ source, target: 'same' }, { source, target: 'same' }]), /collision/);
    const overwrite = await planDeployment(d, [{ source, target: 'existing' }]);
    const backup = await createBackup(d, join(root, 'backups'));
    await assert.rejects(deploy(d, overwrite, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(overwrite) }), /Overwrite/);
    const protectedPlan = await planDeployment(new SimulatedDevice(), [{ source, target: '.boot0' }]);
    await assert.rejects(deploy(new SimulatedDevice(), protectedPlan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(protectedPlan) }), /Protected files/);
    const plan = await planDeployment(d, [{ source, target: 'new-file' }]);
    await assert.rejects(deploy(d, plan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: 'stale' }), /Approved plan hash/);
    const changed = await planDeployment(d, [{ source, target: 'changed-source' }]);
    await writeFile(source, Buffer.from('changed'));
    const changedResult = await deploy(d, changed, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(changed) });
    assert.equal(changedResult.complete, false);
    assert.match(changedResult.results[0].error, /Source changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('physical app replacement rejects an unreviewed previous hash before writing', async () => {
  let requests = 0;
  const adapter = new EspruinoCliAdapter({
    ownership: { 'clock.app.js': 'app:clock' },
    knownFiles: ['clock.app.js'],
    spawnProcess: () => { throw new Error('No process should be started'); }
  });
  adapter._request = async () => { requests++; return true; };
  adapter.inventory = async () => { requests++; return [{ name: 'clock.app.js' }]; };
  await assert.rejects(
    adapter.write('clock.app.js', Buffer.from('new'), { owner: 'app:clock', action: 'update', backupVerified: true }),
    /reviewed previous content hash/i
  );
  assert.equal(requests, 0);
});

test('deployment rejects stale backups and reports partial writes without claiming atomicity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-partial-'));
  try {
    const source1 = join(root, 'one'); const source2 = join(root, 'two');
    await writeFile(source1, Buffer.from('1')); await writeFile(source2, Buffer.from('2'));
    const device = new SimulatedDevice({ baseline: Buffer.from('old') });
    const backup = await createBackup(device, join(root, 'backups'));
    const plan = await planDeployment(device, [{ source: source1, target: 'new1' }, { source: source2, target: 'new2' }]);
    device.files.set('baseline', Buffer.from('changed'));
    await assert.rejects(deploy(device, plan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(plan) }), /stale/);
    device.files.set('baseline', Buffer.from('old'));
    let writes = 0; const write = device.write.bind(device);
    device.write = async (name, data) => { if (++writes === 2) throw new Error('simulated write interruption'); return write(name, data); };
    const result = await deploy(device, plan, { confirm: true, backupDirectory: backup.dir, approvedPlanHash: planHash(plan) });
    assert.equal(result.atomic, false);
    assert.equal(result.complete, false);
    assert.deepEqual(result.results.map(x => x.status), ['written', 'failed']);
    assert.deepEqual(await device.read('new1'), Buffer.from('1'));
    await assert.rejects(device.read('new2'), /missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
