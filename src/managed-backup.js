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

export async function createManagedBackup(device, backupRoot, { mode = 'differential', forceFull = false, includeUnknown = false, ownership = {}, onProgress = () => {} } = {}) {
  if (!['full', 'differential'].includes(mode)) throw new Error('Backup mode must be full or differential.');
  if (includeUnknown !== true && includeUnknown !== false) throw new Error('includeUnknown must be an explicit boolean.');
  await mkdir(backupRoot, { recursive: true });
  const root = resolve(backupRoot);
  let previous = null;
  if (!forceFull && mode !== 'full') {
    const candidates = await readdir(root, { withFileTypes: true });
    for (const item of candidates) if (item.isDirectory()) {
      const path = join(root, item.name);
      try { const check = await verifyManagedBackup(path); const m = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); if (check.complete && (!previous || m.createdAt > previous.manifest.createdAt)) previous = { path, manifest: m }; } catch {}
    }
  }
  if (!previous) mode = 'full';
  const previousFiles = new Map((previous?.manifest.files ?? []).filter(f => f.status === 'captured' || f.status === 'unchanged').map(f => [f.name, f]));
  const dir = resolve(root, backupName()); await mkdir(dir); await mkdir(join(dir, 'files'));
  const warnings = [], entries = [], seen = new Set(); let inventory = [], deviceInfo = null, error;
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
      entry.size = content.length; entry.sha256 = hash(content);
      const old = previousFiles.get(item.name);
      if (old && old.sha256 === entry.sha256 && old.storageFile === entry.storageFile) { entry.status = 'unchanged'; entry.baseBackup = previous.path.split(/[\\/]/).pop(); }
      else { entry.status = 'captured'; await writeFile(join(dir, 'files', item.name), content, { flag: 'wx' }); }
    } catch (e) { entry.status = 'incomplete'; entry.reason = e.message; warnings.push(`${item.name}: ${e.message}`); }
  }
  const after = await device.inventory().catch(e => { error = error ?? e.message; return []; });
  const key = item => `${Boolean(item.storageFile)}:${item.name}:${item.size ?? ''}`;
  const beforeState = inventory.map(key).sort(), afterState = after.map(key).sort();
  const inventoryChanged = beforeState.length !== afterState.length || beforeState.some((value, index) => value !== afterState[index]);
  if (inventoryChanged) warnings.push('Device inventory changed or could not be confirmed during backup.');
  const complete = !error && !inventoryChanged && !warnings.length && entries.every(x => ['captured', 'unchanged', 'excluded', 'metadata-only'].includes(x.status));
  const present = new Set(entries.map(x => x.name));
  const deleted = [...previousFiles.keys()].filter(name => !present.has(name));
  const excluded = entries.filter(entry => ['excluded', 'metadata-only'].includes(entry.status)).map(({ name, classification, status, reason }) => ({ name, classification, status, reason }));
  const manifest = { schemaVersion: 2, kind: 'banglesync-managed-backup', mode, createdAt: new Date().toISOString(), device: deviceInfo, complete, managedScopeComplete: complete, deviceWideBackup: false, excluded, deleted, parent: mode === 'differential' && previous ? previous.path.split(/[\\/]/).pop() : null, inventoryChanged, inventoryError: error ?? null, includeUnknown, files: entries, warnings };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (complete) { await writeFile(join(dir, 'manifest.json'), bytes, { flag: 'wx' }); await writeFile(join(dir, 'manifest.sha256'), `${hash(bytes)}\n`, { flag: 'wx' }); }
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
async function readManagedFile(dir, name) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find(file => file.name === name && ['captured', 'unchanged'].includes(file.status));
  if (!entry) throw new Error(`Managed file is absent from backup chain: ${name}`);
  if (entry.status === 'captured') return readFile(join(dir, 'files', name));
  if (!manifest.parent || entry.baseBackup !== manifest.parent) throw new Error('Invalid unchanged-file chain reference.');
  return readManagedFile(join(dirname(dir), manifest.parent), name);
}
export async function verifyManagedBackup(dir, { baselineRoot, outputDirectory } = {}) {
  const root = resolve(dir); await assertRegularDirectory(root); await assertRegularDirectory(join(root, 'files'));
  const manifestPath = join(root, 'manifest.json'), info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup manifest must be a regular file.');
  const manifestBytes = await readFile(manifestPath), sealInfo = await lstat(join(root, 'manifest.sha256'));
  if (!sealInfo.isFile() || sealInfo.isSymbolicLink() || (await readFile(join(root, 'manifest.sha256'), 'utf8')).trim() !== hash(manifestBytes)) throw new Error('Backup manifest integrity check failed.');
  const m = JSON.parse(manifestBytes.toString('utf8'));
  if (![1, 2].includes(m.schemaVersion) || m.kind !== 'banglesync-managed-backup' || m.deviceWideBackup !== false || !Array.isArray(m.files) || !['full', 'differential'].includes(m.mode)) throw new Error('Invalid or unsafe managed backup manifest.');
  if (m.schemaVersion === 2 && (m.mode === 'full' ? m.parent !== null : typeof m.parent !== 'string')) throw new Error('Managed backup mode has an invalid parent-chain reference.');
  if (m.schemaVersion === 2 && (!Array.isArray(m.deleted) || m.deleted.some(name => !safeName(name)) || new Set(m.deleted).size !== m.deleted.length)) throw new Error('Managed backup deletion metadata is invalid.');
  if (m.schemaVersion === 1 && m.mode === 'differential' && (!m.baseline || !/^[a-f0-9]{40,64}$/i.test(m.baseline.commit))) throw new Error('Differential backup lacks a pinned baseline.');
  if (m.schemaVersion === 1 && m.mode === 'differential' && !baselineRoot) throw new Error('Differential verification and reconstruction require the baseline repository checkout.');
  if (m.schemaVersion === 1 && m.mode === 'differential') {
    if (repoIdentity(m.baseline.repository) !== m.baseline.repositoryIdentity) throw new Error('Baseline repository identity mismatch.');
    await verifyBaselineIdentity(baselineRoot, m.baseline.commit, m.baseline.repository);
  }
  let parentCheck = null, parentDir = null;
  if (m.schemaVersion === 2 && m.parent) {
    if (!safeName(m.parent)) throw new Error('Invalid managed backup parent reference.');
    parentDir = join(dirname(root), m.parent);
    parentCheck = await verifyManagedBackup(parentDir, { baselineRoot });
    if (!parentCheck.complete) throw new Error('Managed backup parent chain is incomplete.');
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
      } else if (f.status === 'unchanged' && m.schemaVersion === 2 && parentCheck) {
        const bytes = await readManagedFile(parentDir, f.name);
        if (bytes.length !== f.size || hash(bytes) !== f.sha256 || f.baseBackup !== m.parent) throw new Error('Unchanged-file chain reference failed verification.');
      } else throw new Error(`Unknown file status: ${f.status}`);
      if (outputDirectory) {
        if (!baselineRoot && f.status === 'baseline-reference') throw new Error('Baseline repository root is required for reconstruction.');
        const content = f.status === 'captured' ? await readFile(join(root, 'files', f.name)) : f.status === 'unchanged' ? await readManagedFile(parentDir, f.name) : await baselineBytes(baselineRoot, m.baseline.commit, f.baseline.path);
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
