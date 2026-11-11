import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { classifyDeviceFile } from './management.js';
import { safeName } from './core.js';

const exec = promisify(execFile);
const hash = data => createHash('sha256').update(data).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const repoIdentity = value => String(value).replace(/\\/g, '/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
async function verifyBaselineIdentity(root, commit, repository) {
  const { stdout: resolvedCommit } = await exec('git', ['-C', root, 'rev-parse', '--verify', `${commit}^{commit}`]);
  if (resolvedCommit.trim().toLowerCase() !== commit.toLowerCase()) throw new Error('Baseline commit must resolve to the exact pinned Git SHA.');
  const { stdout: remote } = await exec('git', ['-C', root, 'remote', 'get-url', 'origin']);
  if (repoIdentity(remote.trim()) !== repoIdentity(repository)) throw new Error('Baseline repository identity does not match origin.');
}
const backupName = () => new Date().toISOString().replace(/[:.]/g, '-');

async function baselineBytes(root, commit, path) {
  const { stdout } = await exec('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  return Buffer.from(stdout);
}

export async function createManagedBackup(device, backupRoot, { mode = 'full', includeUnknown = false, ownership = {}, baseline = null, onProgress = () => {} } = {}) {
  if (!['full', 'differential'].includes(mode)) throw new Error('Backup mode must be full or differential.');
  if (mode === 'differential' && (!baseline?.root || !baseline?.commit || !baseline?.repository)) throw new Error('Differential backup requires an explicit repository root, exact commit SHA, and repository identity.');
  if (includeUnknown !== true && includeUnknown !== false) throw new Error('includeUnknown must be an explicit boolean.');
  if (mode === 'differential' && !/^[a-f0-9]{40,64}$/i.test(baseline.commit)) throw new Error('Baseline commit must be an exact Git commit SHA.');
  if (mode === 'differential') await verifyBaselineIdentity(baseline.root, baseline.commit, baseline.repository);
  await mkdir(backupRoot, { recursive: true });
  const dir = resolve(backupRoot, backupName());
  await mkdir(dir); await mkdir(join(dir, 'files'));
  const warnings = [], entries = [], seen = new Set();
  let inventory = [], deviceInfo = null, error;
  try { deviceInfo = await device.info(); inventory = await device.inventory(); } catch (e) { error = e.message; }
  for (const item of inventory) {
    onProgress({ completed: entries.length, total: inventory.length });
    const category = classifyDeviceFile(item, ownership);
    const entry = { name: item.name, storageFile: Boolean(item.storageFile), size: Number.isSafeInteger(item.size) ? item.size : null, classification: category.classification, eligible: category.eligible, owner: category.owner ?? null, status: 'metadata-only', sha256: null };
    entries.push(entry);
    if (!safeName(item.name) || seen.has(`${entry.storageFile}:${item.name}`)) { entry.status = 'excluded'; entry.reason = 'invalid or duplicate inventory filename'; warnings.push(`${item.name}: invalid/duplicate inventory entry`); continue; }
    seen.add(`${entry.storageFile}:${item.name}`);
    if (category.classification === 'protected-system') { entry.status = 'excluded'; entry.reason = 'protected system file'; continue; }
    if (category.classification === 'unknown' && !includeUnknown) { entry.reason = 'unknown files are metadata-only unless explicitly included'; continue; }
    if (!category.eligible && !['unknown', 'known-application'].includes(category.classification)) { entry.reason = 'file is not in the managed backup scope'; continue; }
    try {
      const content = await device.read(item.name, { storageFile: entry.storageFile });
      if (!Buffer.isBuffer(content)) throw new Error('transport returned non-binary content');
      if (item.size !== undefined && item.size !== null && item.size !== content.length) throw new Error('content size differs from inventory');
      if (entry.storageFile && content.includes(255)) throw new Error('StorageFile contains unsupported 0xFF and cannot be verified as a complete logical backup.');
      const confirmation = await device.read(item.name, { storageFile: entry.storageFile });
      if (!Buffer.isBuffer(confirmation) || !confirmation.equals(content)) throw new Error('Device file changed during backup capture.');
      entry.size = content.length; entry.sha256 = hash(content); entry.status = 'captured';
      if (mode === 'differential') {
        try {
          const path = item.baselinePath ?? item.name;
          if (typeof path !== 'string' || path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new Error('Unsafe baseline path');
          const upstream = await baselineBytes(baseline.root, baseline.commit, path);
          if (upstream.equals(content)) {
            entry.status = 'baseline-reference';
            entry.baseline = { repository: baseline.repository, commit: baseline.commit, path, sha256: hash(upstream) };
            continue;
          }
        } catch {}
      }
      await writeFile(join(dir, 'files', item.name), content, { flag: 'wx' });
    } catch (e) { entry.status = 'incomplete'; entry.reason = e.message; warnings.push(`${item.name}: ${e.message}`); }
  }
  let after = [];
  try { after = await device.inventory(); } catch (e) { error = error ?? e.message; }
  const key = item => `${Boolean(item.storageFile)}:${item.name}:${item.size ?? ''}`;
  const beforeState = inventory.map(key).sort(), afterState = after.map(key).sort();
  const inventoryChanged = beforeState.length !== afterState.length || beforeState.some((value, index) => value !== afterState[index]);
  if (inventoryChanged) warnings.push('Device inventory changed or could not be confirmed during backup.');
  const managedScopeComplete = !error && !inventoryChanged && !warnings.length && entries.every(x => ['captured', 'baseline-reference', 'excluded'].includes(x.status));
  const excluded = entries.filter(entry => ['excluded', 'metadata-only'].includes(entry.status)).map(({ name, classification, status, reason }) => ({ name, classification, status, reason }));
  const manifest = { schemaVersion: 1, kind: 'banglesync-managed-backup', mode, createdAt: new Date().toISOString(), device: deviceInfo, complete: managedScopeComplete, managedScopeComplete, deviceWideBackup: false, excluded, inventoryChanged, inventoryError: error ?? null, includeUnknown, baseline: mode === 'differential' ? { repository: baseline.repository, repositoryIdentity: repoIdentity(baseline.repository), commit: baseline.commit } : null, files: entries, warnings };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, 'manifest.json'), manifestBytes, { flag: 'wx' });
  await writeFile(join(dir, 'manifest.sha256'), `${hash(manifestBytes)}\n`, { flag: 'wx' });
  return { dir, manifest };
}

export async function createBackupFromImport(importDirectory, backupRoot) {
  const source = resolve(importDirectory), importManifestPath = join(source, 'manifest.json');
  const sourceInfo = await lstat(source), manifestInfo = await lstat(importManifestPath);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('Device-import snapshot must be a regular directory with a regular manifest.');
  const importBytes = await readFile(importManifestPath), seal = (await readFile(join(source, 'manifest.sha256'), 'utf8')).trim();
  if (seal !== hash(importBytes)) throw new Error('Device-import manifest integrity check failed.');
  const snapshot = JSON.parse(importBytes.toString('utf8'));
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'banglesync-device-import' || snapshot.scope !== 'selected-catalogued-user-files-only' || snapshot.snapshotComplete !== true || !Array.isArray(snapshot.snapshotFiles) || !Array.isArray(snapshot.scopeFiles)) throw new Error('Import does not contain a complete selected user-file snapshot.');
  if (snapshot.scopeFiles.length !== snapshot.snapshotFiles.length || new Set(snapshot.scopeFiles).size !== snapshot.scopeFiles.length) throw new Error('Import snapshot scope is incomplete or contains duplicate filenames.');
  const dir = resolve(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backupRoot, { recursive: true }); await mkdir(dir); await mkdir(join(dir, 'files'));
  const entries = [], seen = new Set(), warnings = [];
  for (const file of snapshot.snapshotFiles) {
    if (!safeName(file.name) || seen.has(file.name)) throw new Error('Import snapshot contains an invalid or duplicate filename.');
    seen.add(file.name);
    const bytes = await readFile(join(source, 'snapshot', file.name));
    const entry = { name: file.name, storageFile: Boolean(file.storageFile), size: bytes.length, sha256: hash(bytes), classification: file.classification, eligible: true, owner: file.owner ?? null, application: file.application ?? null, status: 'captured' };
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) { entry.status = 'incomplete'; entry.reason = 'cached snapshot size/hash mismatch'; warnings.push(`${file.name}: snapshot integrity mismatch`); }
    else if (entry.storageFile && bytes.includes(255)) { entry.status = 'incomplete'; entry.reason = 'StorageFile contains unsupported 0xFF'; warnings.push(`${file.name}: unsupported StorageFile encoding`); }
    else await writeFile(join(dir, 'files', file.name), bytes, { flag: 'wx' });
    entries.push(entry);
  }
  const complete = warnings.length === 0 && entries.length === snapshot.scopeFiles.length && entries.every(file => file.status === 'captured');
  const manifest = { schemaVersion: 1, kind: 'banglesync-managed-backup', mode: 'full', createdAt: new Date().toISOString(), device: { transport: 'catalog-bounded EspruinoTools import', identity: 'not recorded', firmware: 'not inspected' }, complete, managedScopeComplete: complete, deviceWideBackup: false, excluded: [], inventoryChanged: false, inventoryError: null, includeUnknown: false, baseline: null, files: entries, warnings, sourceImport: resolve(source) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, 'manifest.json'), manifestBytes, { flag: 'wx' });
  await writeFile(join(dir, 'manifest.sha256'), `${hash(manifestBytes)}\n`, { flag: 'wx' });
  return { dir, manifest };
}

async function assertRegularDirectory(path) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a regular directory: ${path}`); }
export async function verifyManagedBackup(dir, { baselineRoot, outputDirectory } = {}) {
  const root = resolve(dir); await assertRegularDirectory(root); await assertRegularDirectory(join(root, 'files'));
  const manifestPath = join(root, 'manifest.json'), info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup manifest must be a regular file.');
  const manifestBytes = await readFile(manifestPath), sealInfo = await lstat(join(root, 'manifest.sha256'));
  if (!sealInfo.isFile() || sealInfo.isSymbolicLink() || (await readFile(join(root, 'manifest.sha256'), 'utf8')).trim() !== hash(manifestBytes)) throw new Error('Backup manifest integrity check failed.');
  const m = JSON.parse(manifestBytes.toString('utf8'));
  if (m.schemaVersion !== 1 || m.kind !== 'banglesync-managed-backup' || m.deviceWideBackup !== false || !Array.isArray(m.files) || !['full', 'differential'].includes(m.mode)) throw new Error('Invalid or unsafe managed backup manifest.');
  if (m.mode === 'differential' && (!m.baseline || !/^[a-f0-9]{40,64}$/i.test(m.baseline.commit))) throw new Error('Differential backup lacks a pinned baseline.');
  if (m.mode === 'differential' && !baselineRoot) throw new Error('Differential verification and reconstruction require the baseline repository checkout.');
  if (m.mode === 'differential') {
    if (repoIdentity(m.baseline.repository) !== m.baseline.repositoryIdentity) throw new Error('Baseline repository identity mismatch.');
    await verifyBaselineIdentity(baselineRoot, m.baseline.commit, m.baseline.repository);
  }
  if (outputDirectory) {
    const preflight = await verifyManagedBackup(root, { baselineRoot });
    if (!preflight.complete) throw new Error('Backup is incomplete or failed verification; reconstruction was not started.');
    await mkdir(resolve(outputDirectory), { recursive: false });
  }
  const results = [], expected = new Set(), seen = new Set();
  for (const f of m.files) {
    let status = 'verified', reason;
    try {
      if (!safeName(f.name) || seen.has(f.name)) throw new Error('Unsafe or duplicate filename.');
      seen.add(f.name);
      if (f.status === 'excluded' || f.status === 'metadata-only') { if (f.classification === 'protected-system' && f.status !== 'excluded') throw new Error('Protected entry must not contain captured data.'); results.push({ name: f.name, status: f.status }); continue; }
      if (f.status === 'incomplete') throw new Error('File was not completely captured.');
      if (!Number.isSafeInteger(f.size) || f.size < 0 || !shaPattern.test(f.sha256 ?? '')) throw new Error('Invalid size or content hash.');
      if (f.status === 'baseline-reference') {
        if (m.mode !== 'differential' || f.baseline?.commit !== m.baseline.commit || f.baseline?.repository !== m.baseline.repository || f.baseline?.path !== f.name || f.baseline.sha256 !== f.sha256) throw new Error('Baseline reference does not match pinned manifest.');
        if (baselineRoot) { const bytes = await baselineBytes(baselineRoot, m.baseline.commit, f.baseline.path); if (bytes.length !== f.size || hash(bytes) !== f.sha256) throw new Error('Pinned baseline file hash mismatch.'); }
        else if (outputDirectory) throw new Error('Baseline repository root is required for reconstruction.');
      } else if (f.status === 'captured') {
        const contentPath = join(root, 'files', f.name), contentInfo = await lstat(contentPath);
        if (!contentInfo.isFile() || contentInfo.isSymbolicLink()) throw new Error('Captured file is not a regular file.');
        const data = await readFile(contentPath); if (data.length !== f.size || hash(data) !== f.sha256) throw new Error('Captured content hash mismatch.');
        expected.add(f.name);
      } else throw new Error(`Unknown file status: ${f.status}`);
      if (outputDirectory) {
        if (!baselineRoot && f.status === 'baseline-reference') throw new Error('Baseline repository root is required for reconstruction.');
        const content = f.status === 'captured' ? await readFile(join(root, 'files', f.name)) : await baselineBytes(baselineRoot, m.baseline.commit, f.baseline.path);
        const target = resolve(outputDirectory, f.name);
        if (!target.startsWith(`${resolve(outputDirectory)}\\`)) throw new Error('Unsafe reconstruction path.');
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' });
      }
    } catch (e) { status = 'failed'; reason = e.message; }
    results.push({ name: f.name, status, reason });
  }
  const actual = await readdir(join(root, 'files'));
  if (actual.length !== expected.size || actual.some(x => !expected.has(x))) results.push({ name: 'files/', status: 'failed', reason: 'Missing or unmanifested backup contents.' });
  const complete = m.complete === true && m.managedScopeComplete === true && !m.inventoryChanged && !m.inventoryError && results.every(x => ['verified', 'excluded', 'metadata-only'].includes(x.status));
  const reconstructableFiles = results.filter(file => file.status === 'verified').length;
  return { complete, managedScopeReconstructable: complete, deviceWideReconstructable: false, expectedFiles: m.files.length, reconstructableFiles, excluded: m.excluded ?? [], mode: m.mode, files: results, reconstructedTo: outputDirectory ? resolve(outputDirectory) : null, warnings: m.warnings ?? [] };
}
