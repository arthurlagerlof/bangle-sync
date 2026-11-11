import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceCatalog } from '../bin/bangle-sync.js';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';
import { initializeManagedWorkspace } from '../src/management.js';
import { createBackupFromImport, verifyManagedBackup } from '../src/managed-backup.js';

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
