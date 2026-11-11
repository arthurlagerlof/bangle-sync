import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
export function safeName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name) && !/[<>:"|?*]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export class SimulatedDevice {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]));
    this.connected = false;
    this.name = 'Bangle.js (simulated)';
    this.firmware = 'simulated';
  }
  async discover() { return [{ id: 'simulated', name: this.name }]; }
  async connect() { this.connected = true; return this.info(); }
  async disconnect() { this.connected = false; }
  async info() { return { name: this.name, firmware: this.firmware, transport: 'simulated' }; }
  async inventory() { return [...this.files].map(([name, data]) => ({ name, storageFile: false, size: data.length })); }
  async read(name) { if (!this.files.has(name)) throw new Error(`Unreadable/missing file: ${name}`); return Buffer.from(this.files.get(name)); }
  async write(name, data) { this.files.set(name, Buffer.from(data)); }
}

function compareInventory(a, b) {
  const normalize = list => list.map(x => ({ name: x.name, storageFile: Boolean(x.storageFile), size: x.size })).sort((x, y) => `${x.storageFile}:${x.name}`.localeCompare(`${y.storageFile}:${y.name}`));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function backupFilename(item) { return join(item.storageFile ? 'storage-files' : 'ordinary', item.name); }
export async function createBackup(device, root) {
  if (!(device instanceof SimulatedDevice)) throw new Error('Legacy logical backup is simulator-only; physical backups must use the managed, protection-aware backup pipeline.');
  await mkdir(root, { recursive: true });
  const dir = resolve(root, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: false });
  await mkdir(join(dir, 'ordinary'));
  await mkdir(join(dir, 'storage-files'));
  const entries = [];
  let info = null, before = [], after = [], inventoryError;
  try { info = await device.info(); before = await device.inventory(); }
  catch (error) { inventoryError = error.message; }
  const names = new Set();
  for (const item of before) {
    const key = `${Boolean(item.storageFile)}:${item.name}`;
    const entry = { name: item.name, storageFile: Boolean(item.storageFile), size: null, sha256: null, status: 'pending' };
    entries.push(entry);
    try {
      if (!safeName(item.name)) throw new Error('Invalid device filename');
      if (names.has(key)) throw new Error('Duplicate filename in inventory');
      names.add(key);
      const first = await device.read(item.name, { storageFile: entry.storageFile });
      if (!Buffer.isBuffer(first)) throw new Error('Transport did not return binary data');
      entry.size = first.length;
      entry.sha256 = digest(first);
      if (item.size !== undefined && item.size !== first.length) throw new Error('Length differs from inventory');
      const file = join(dir, backupFilename(entry));
      await writeFile(file, first, { flag: 'wx' });
      const saved = await readFile(file);
      if (!saved.equals(first)) throw new Error('Backup byte verification failed');
      const second = await device.read(item.name, { storageFile: entry.storageFile });
      if (!Buffer.isBuffer(second) || !second.equals(first)) throw new Error('Device file changed during backup');
      if (entry.storageFile && first.includes(255)) {
        entry.status = 'unsupported-lossy-storagefile';
        entry.error = 'StorageFile representation cannot prove preservation of 0xFF';
      } else entry.status = 'verified';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  }
  try { after = await device.inventory(); } catch (error) { inventoryError = error.message; }
  const changed = Boolean(inventoryError) || !compareInventory(before, after);
  if (changed) for (const entry of entries) if (entry.status === 'verified') { entry.status = 'inventory-changed'; entry.error = 'Inventory changed or could not be reread during backup'; }
  const complete = !changed && !inventoryError && entries.length === before.length && entries.every(x => x.status === 'verified');
  const manifest = { schemaVersion: 1, kind: 'logical-storage-backup', createdAt: new Date().toISOString(), device: info, complete, inventoryChanged: changed, inventoryError, files: entries };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(dir, 'verification.json'), `${JSON.stringify({ complete, checkedAt: new Date().toISOString(), files: entries.map(({ name, storageFile, status, size, sha256, error }) => ({ name, storageFile, status, size, sha256, error })) }, null, 2)}\n`, { flag: 'wx' });
  return { dir, manifest };
}

export async function verifyBackup(dir) {
  const base = resolve(dir);
  const rootInfo = await lstat(base);
  const manifestInfo = await lstat(join(base, 'manifest.json'));
  if (!rootInfo.isDirectory() || !manifestInfo.isFile()) throw new Error('Backup directory or manifest is not a regular filesystem entry');
  for (const subdir of ['ordinary', 'storage-files']) {
    const info = await lstat(join(base, subdir));
    if (!info.isDirectory()) throw new Error(`Backup ${subdir} entry is not a regular directory`);
  }
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'logical-storage-backup' || !Array.isArray(manifest.files)) throw new Error('Unsupported or invalid backup manifest');
  const results = [], expected = { ordinary: new Set(), 'storage-files': new Set() };
  const seen = new Set();
  for (const file of manifest.files) {
    let status = 'verified', error;
    try {
      if (!safeName(file.name)) throw new Error('Invalid filename in manifest');
      const key = `${Boolean(file.storageFile)}:${file.name}`;
      if (seen.has(key)) throw new Error('Duplicate filename in manifest');
      seen.add(key);
      if (file.status !== 'verified' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Backup entry was not complete (${file.status})`);
      const subdir = file.storageFile ? 'storage-files' : 'ordinary';
      expected[subdir].add(file.name);
      const filename = join(base, subdir, file.name);
      const details = await lstat(filename);
      if (!details.isFile()) throw new Error('Backup entry is not a regular file');
      const data = await readFile(filename);
      if (data.length !== file.size || digest(data) !== file.sha256) throw new Error('Size or SHA-256 mismatch');
      if (file.storageFile && data.includes(255)) throw new Error('StorageFile contains unsupported 0xFF');
    } catch (e) { status = 'failed'; error = e.message; }
    results.push({ name: file.name, storageFile: Boolean(file.storageFile), status, error });
  }
  for (const subdir of Object.keys(expected)) {
    const names = await readdir(join(base, subdir));
    if (names.length !== expected[subdir].size || names.some(name => !expected[subdir].has(name))) results.push({ name: subdir, status: 'failed', error: 'Backup directory contains missing or unmanifested entries' });
  }
  const complete = manifest.complete === true && !manifest.inventoryChanged && !manifest.inventoryError && results.length === manifest.files.length && results.every(x => x.status === 'verified');
  const report = { complete, checkedAt: new Date().toISOString(), files: results };
  await writeFile(join(base, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export const PROTECTED = new Set(['.bootcde', '.boot0', '.bootPowerOn', '.splash', 'boot.info', 'bootupdate.js']);
const PROTECTED_SYSTEM_NAME = /^(?:\.boot.*|boot.*|(?:firmware|espruino|flash|ble|recovery)(?:\.|$)|(?:Storage|heatshrink|locale|math|crypto|Bluetooth|Bangle|Graphics|Modules|E)\.js$|core(?:\.js)?(?:\.|$))/i;
export function classifyDeviceFile(name, { owned = new Set(), knownApplication = false, allowlistedConfiguration = false } = {}) {
  if (!safeName(name)) return { classification: 'protected-system', eligible: false, reason: 'invalid filename' };
  if (PROTECTED.has(name) || PROTECTED_SYSTEM_NAME.test(name)) return { classification: 'protected-system', eligible: false };
  if (owned.has(name)) return { classification: 'banglesync-managed', eligible: true };
  if (allowlistedConfiguration) return { classification: 'allowlisted-configuration', eligible: true };
  if (knownApplication) return { classification: 'known-application', eligible: false };
  return { classification: 'unknown', eligible: false };
}
export async function planDeployment(device, mappings) {
  if (!Array.isArray(mappings) || !mappings.length) throw new Error('At least one explicit source-to-device mapping is required');
  const current = await device.inventory();
  const currentNames = new Set(current.map(x => x.name));
  const targets = new Set(), sources = new Set(), plan = [];
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.source !== 'string' || !mapping.source.trim() || !safeName(mapping.target)) throw new Error('Invalid explicit source-to-device mapping');
    if (targets.has(mapping.target)) throw new Error(`Target collision: ${mapping.target}`);
    targets.add(mapping.target);
    const source = resolve(mapping.source);
    if (sources.has(source)) throw new Error(`Source collision: ${mapping.source}`);
    sources.add(source);
    const data = await readFile(source);
    const exists = currentNames.has(mapping.target);
    const protectedTarget = PROTECTED.has(mapping.target) || PROTECTED_SYSTEM_NAME.test(mapping.target);
    plan.push({ source, target: mapping.target, action: exists ? 'overwrite' : 'create', protected: protectedTarget, size: data.length, sha256: digest(data) });
  }
  return plan;
}

export async function deploy(device, plan, { confirm = false, backupDirectory, approvedPlanHash, workspaceRoot } = {}) {
  if (!(device instanceof SimulatedDevice)) throw new Error('Legacy deployment is simulator-only; use the protection-aware sync engine for physical devices.');
  if (!Array.isArray(plan) || !plan.length) throw new Error('A non-empty deployment plan is required');
  if (!confirm) throw new Error('Explicit --confirm is required');
  if (plan.some(x => x.action !== 'create')) throw new Error('Overwrite or unknown actions are refused');
  if (plan.some(x => x.protected || PROTECTED.has(x.target) || PROTECTED_SYSTEM_NAME.test(x.target))) throw new Error('Protected files are never writable; no override is available.');
  if (!backupDirectory) throw new Error('A verified pre-deployment backup is required');
  if (workspaceRoot) {
    const rel = relative(resolve(workspaceRoot), resolve(backupDirectory));
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw new Error('Pre-deployment backup must be outside the workspace');
  }
  const verification = await verifyBackup(backupDirectory);
  if (!verification.complete) throw new Error('Pre-deployment backup is incomplete or invalid');
  const backupManifest = JSON.parse(await readFile(join(backupDirectory, 'manifest.json'), 'utf8'));
  const currentInventory = await device.inventory();
  if (!compareInventory(backupManifest.files, currentInventory)) throw new Error('Pre-deployment backup is stale: device inventory changed');
  for (const file of backupManifest.files) {
    const currentBytes = await device.read(file.name, { storageFile: Boolean(file.storageFile) });
    if (!Buffer.isBuffer(currentBytes) || currentBytes.length !== file.size || digest(currentBytes) !== file.sha256) throw new Error(`Pre-deployment backup is stale: ${file.name} changed`);
  }
  const actualHash = digest(Buffer.from(JSON.stringify(plan)));
  if (approvedPlanHash !== actualHash) throw new Error('Approved plan hash does not match; review the current plan before writing');
  const now = await device.inventory(), present = new Set(now.map(x => x.name));
  if (plan.some(x => present.has(x.target))) throw new Error('Target now exists; refusing stale-plan overwrite');
  const results = [];
  for (const item of plan) {
    try {
      if (!safeName(item.target)) throw new Error('Invalid target filename');
      const data = await readFile(item.source);
      if (data.length !== item.size || digest(data) !== item.sha256) throw new Error('Source changed after plan approval');
      await device.write(item.target, data);
      results.push({ target: item.target, source: item.source, sha256: item.sha256, status: 'written' });
    } catch (error) { results.push({ target: item.target, source: item.source, status: 'failed', error: error.message }); break; }
  }
  return { atomic: false, results, complete: results.length === plan.length && results.every(x => x.status === 'written') };
}
export function planHash(plan) { return digest(Buffer.from(JSON.stringify(plan))); }
