import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceCatalog } from '../bin/bangle-sync.js';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';
import { initializeManagedWorkspace } from '../src/management.js';
import { createBackupFromImport, createManagedBackup, verifyManagedBackup } from '../src/managed-backup.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');

test('device catalog scope excludes every unselected upstream application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-scope-'));
  try {
    const alarm = join(root, 'BangleApps', 'apps', 'alarm'), other = join(root, 'BangleApps', 'apps', 'other');
    await mkdir(alarm, { recursive: true }); await mkdir(other, { recursive: true });
    await writeFile(join(alarm, 'metadata.json'), JSON.stringify({ id: 'alarm', name: 'Alarm', version: '1', storage: [{ name: 'alarm.app.js', url: 'app.js' }] }));
    await writeFile(join(other, 'metadata.json'), JSON.stringify({ id: 'other', name: 'Other', version: '1', storage: [{ name: 'other.app.js', url: 'app.js' }] }));
    await initializeManagedWorkspace(root);
    await writeFile(join(root, 'manifests', 'desired.json'), JSON.stringify({ files: [], ownership: {} }));
    const scope = await deviceCatalog(root, ['alarm']);
    assert.deepEqual(scope.knownFiles, ['alarm.app.js']);
    assert.deepEqual(scope.appIds, ['alarm']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('device adapter probes only explicitly catalogued settings', () => {
  const unregistered = new EspruinoCliAdapter({ knownFiles: ['clock.app.js'] });
  assert.deepEqual(unregistered.knownFiles, ['clock.app.js']);
  const registered = new EspruinoCliAdapter({ knownFiles: ['clock.app.js', 'setting.json'] });
  assert.deepEqual(registered.knownFiles, ['clock.app.js', 'setting.json']);
});

test('managed physical backups default to chained diffs and reconstruct the current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-managed-chain-')), backupRoot = join(root, 'backups');
  const files = new Map([['clock.app.js', Buffer.from('v1')], ['removed.app.js', Buffer.from('gone')]]);
  const device = { info: async () => ({ transport: 'test' }), inventory: async () => [...files].map(([name, bytes]) => ({ name, size: bytes.length, storageFile: false })), read: async name => Buffer.from(files.get(name)) };
  const ownership = { 'clock.app.js': 'app:clock', 'removed.app.js': 'app:removed', 'new.app.js': 'app:new' };
  try {
    const full = await createManagedBackup(device, backupRoot, { ownership });
    assert.equal(full.manifest.mode, 'full');
    const unchanged = await createManagedBackup(device, backupRoot, { ownership });
    assert.equal(unchanged.manifest.mode, 'differential');
    assert.equal(unchanged.manifest.files.find(file => file.name === 'clock.app.js').status, 'unchanged');
    assert.equal((await readdir(join(unchanged.dir, 'files'))).length, 0);
    files.set('new.app.js', Buffer.from('new'));
    const added = await createManagedBackup(device, backupRoot, { ownership });
    assert.equal(added.manifest.files.find(file => file.name === 'new.app.js').status, 'captured');
    files.set('clock.app.js', Buffer.from('v2')); files.delete('removed.app.js');
    const diff = await createManagedBackup(device, backupRoot, { ownership });
    assert.equal(diff.manifest.mode, 'differential');
    assert.deepEqual(diff.manifest.deleted, ['removed.app.js']);
    assert.equal(diff.manifest.files.find(file => file.name === 'clock.app.js').status, 'captured');
    assert.equal((await verifyManagedBackup(diff.dir)).complete, true);
    const destination = join(root, 'restored');
    assert.equal((await verifyManagedBackup(diff.dir, { outputDirectory: destination })).complete, true);
    assert.deepEqual(await readFile(join(destination, 'clock.app.js')), Buffer.from('v2'));
    assert.deepEqual(await readFile(join(destination, 'new.app.js')), Buffer.from('new'));
    await assert.rejects(readFile(join(destination, 'removed.app.js')), { code: 'ENOENT' });
    assert.equal((await createManagedBackup(device, backupRoot, { ownership, forceFull: true })).manifest.mode, 'full');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted managed backup is unsealed and ignored as a future baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-managed-interrupted-')), backupRoot = join(root, 'backups');
  const bytes = Buffer.from('file bytes');
  const device = { info: async () => ({ transport: 'test' }), inventory: async () => [{ name: 'clock.app.js', size: bytes.length, storageFile: false }], read: async () => { throw new Error('disconnected mid-read'); } };
  try {
    const interrupted = await createManagedBackup(device, backupRoot, { ownership: { 'clock.app.js': 'app:clock' } });
    assert.equal(interrupted.manifest.complete, false);
    await assert.rejects(readFile(join(interrupted.dir, 'manifest.json')), { code: 'ENOENT' });
    const workingDevice = { ...device, read: async () => Buffer.from(bytes) };
    const recovered = await createManagedBackup(workingDevice, backupRoot, { ownership: { 'clock.app.js': 'app:clock' } });
    assert.equal(recovered.manifest.complete, true);
    assert.equal(recovered.manifest.mode, 'full');
    assert.equal(recovered.manifest.parent, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pulled user-file snapshot materializes as an independent verifiable backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-cache-'));
  const imported = join(root, 'import'), snapshot = join(imported, 'snapshot'), backupRoot = join(root, 'backups');
  await mkdir(snapshot, { recursive: true });
  try {
    const contents = Buffer.from('catalogued app bytes');
    const record = { name: 'alarm.app.js', storageFile: false, application: 'alarm', classification: 'known-application', size: contents.length, sha256: sha256(contents), owner: 'app:alarm', baseline: null };
    await writeFile(join(snapshot, record.name), contents);
    const manifest = { schemaVersion: 1, kind: 'banglesync-device-import', snapshotComplete: true, scope: 'selected-catalogued-user-files-only', scopeFiles: [record.name], snapshotFiles: [record], files: [] };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(imported, 'manifest.json'), bytes);
    await writeFile(join(imported, 'manifest.sha256'), `${sha256(bytes)}\n`);
    const backup = await createBackupFromImport(imported, backupRoot);
    assert.equal(backup.manifest.complete, true);
    assert.equal(backup.manifest.deviceWideBackup, false);
    assert.deepEqual(await readFile(join(backup.dir, 'files', record.name)), contents);
    assert.equal((await verifyManagedBackup(backup.dir)).complete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
