import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep, isAbsolute } from 'node:path';
import { safeName, classifyDeviceFile } from './core.js';
import { recordOwnedFile, assertManagedTarget } from './management.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function syncPlanHash(plan) {
  const body = { workspaceRoot: resolve(plan.workspaceRoot), ownership: plan.ownership, plan: plan.plan.map(({ source, target, owner, storageFile, action, size, sha256: digest, previousSha256 }) => ({ source, target, owner, storageFile, action, size, sha256: digest, previousSha256 })), conflicts: plan.conflicts };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
const under = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export async function planSync({ workspaceRoot, device, desiredFiles, ownership = {}, backupVerified = false, allowedTargets = null }) {
  if (!Array.isArray(desiredFiles)) throw new Error('desiredFiles must be a list of explicit workspace-to-device mappings.');
  const root = await realpath(workspaceRoot), current = await device.inventory(), allowed = allowedTargets ? new Set(allowedTargets) : null;
  const inventory = new Map(), inventoryNames = new Set(), targets = new Set(), plan = [], conflicts = [], unchanged = [];
  for (const file of current) {
    if (!safeName(file.name) || inventoryNames.has(file.name)) { conflicts.push({ target: file.name, reason: 'invalid or duplicate device inventory filename' }); continue; }
    inventoryNames.add(file.name); inventory.set(file.name, file);
  }
  for (const item of desiredFiles) {
    if (!item || typeof item.source !== 'string' || !safeName(item.target) || typeof item.owner !== 'string' || !/^(?:app|behaviour):[a-z0-9][a-z0-9_-]{0,39}$/.test(item.owner)) throw new Error('Each desired file requires a safe target and explicit app:<id> or behaviour:<id> owner.');
    if (targets.has(item.target)) throw new Error(`Duplicate desired target: ${item.target}`);
    targets.add(item.target);
    if (allowed && !allowed.has(item.target)) { conflicts.push({ target: item.target, reason: 'target is outside declared app, behaviour, setting, and owned-file catalogs' }); continue; }
    const source = resolve(root, item.source);
    if (!under(root, source)) throw new Error(`Source escapes workspace: ${item.source}`);
    const sourceReal = await realpath(source);
    if (!under(root, sourceReal)) throw new Error(`Source symlink escapes workspace: ${item.source}`);
    const bytes = await readFile(sourceReal), sourceHash = sha256(bytes), existing = inventory.get(item.target);
    try { assertManagedTarget(item.target, { ownership, operation: existing ? 'update' : 'create', exists: Boolean(existing), owner: item.owner }); }
    catch (error) { conflicts.push({ target: item.target, reason: error.message }); continue; }
    let previousSha256 = null;
    if (existing) {
      let remoteHash = typeof existing.sha256 === 'string' && /^[a-f0-9]{64}$/.test(existing.sha256) && existing.hashVerified === true ? existing.sha256 : null;
      if (!remoteHash) {
        try { const remote = await device.read(item.target, { storageFile: Boolean(existing.storageFile) }); if (!Buffer.isBuffer(remote)) throw new Error('non-binary read result'); remoteHash = sha256(remote); }
        catch { conflicts.push({ target: item.target, reason: 'existing managed file cannot be verified/read' }); continue; }
      }
      if (remoteHash === sourceHash) { unchanged.push({ target: item.target, sha256: sourceHash, status: 'already-current' }); continue; }
      previousSha256 = remoteHash;
    }
    plan.push({ source: sourceReal, target: item.target, owner: item.owner, storageFile: existing ? Boolean(existing.storageFile) : false, action: existing ? 'update' : 'create', size: bytes.length, sha256: sourceHash, previousSize: existing?.size ?? null, previousSha256, backupVerified: Boolean(backupVerified) });
  }
  const planOwnership = Object.fromEntries(plan.map(item => [item.target, item.owner]));
  return { schemaVersion: 1, kind: 'banglesync-sync-plan', createdAt: new Date().toISOString(), dryRun: true, workspaceRoot: root, backupVerified: Boolean(backupVerified), ownership: planOwnership, plan, unchanged, conflicts, unknown: current.filter(file => classifyDeviceFile(file.name, { owned: new Set(Object.keys(ownership)), knownApplication: Boolean(file.application || file.applicationCandidates?.length), allowlistedConfiguration: ['setting.json', 'wid_settings.json'].includes(file.name) }).classification === 'unknown').map(file => ({ name: file.name, status: 'left-untouched' })), protected: current.filter(file => classifyDeviceFile(file.name).classification === 'protected-system').map(file => ({ name: file.name, status: 'left-untouched' })), applicable: conflicts.length === 0 };
}

export async function applySyncPlan(device, approvedPlan, { confirm = false, backupVerified = false, ownership = {}, approvedPlanHash } = {}) {
  if (!confirm) throw new Error('Applying a sync plan requires explicit confirmation.');
  if (!approvedPlan || approvedPlan.kind !== 'banglesync-sync-plan' || approvedPlan.dryRun !== true) throw new Error('Invalid or unreviewed sync plan.');
  if (!approvedPlan.applicable || approvedPlan.conflicts.length) throw new Error('Sync plan contains conflicts; resolve them before applying.');
  if (typeof approvedPlanHash !== 'string' || syncPlanHash(approvedPlan) !== approvedPlanHash) throw new Error('Reviewed plan hash does not match the current plan. Re-preview before applying.');
  if (!backupVerified && approvedPlan.plan.some(item => item.action === 'update')) throw new Error('Updating owned files requires a verified pre-change backup.');
  let current = new Map((await device.inventory()).map(file => [file.name, file]));
  const results = [];
  for (const item of approvedPlan.plan) {
    const states = ['pending'];
    try {
      const latest = await device.inventory();
      if (latest.some((file, index) => !safeName(file.name) || latest.findIndex(other => other.name === file.name) !== index)) throw new Error('Device inventory contains invalid or duplicate filenames.');
      current = new Map(latest.map(file => [file.name, file]));
      if (!safeName(item.target) || typeof item.owner !== 'string' || !/^(?:app|behaviour):[a-z0-9][a-z0-9_-]{0,39}$/.test(item.owner) || !['create', 'update'].includes(item.action)) throw new Error('Invalid sync action, target, or owner.');
      const exists = current.has(item.target);
      if ((item.action === 'create' && exists) || (item.action === 'update' && !exists)) throw new Error('Device changed since preview; create/update state is stale.');
      assertManagedTarget(item.target, { ownership, operation: item.action, exists, owner: item.owner });
      if (item.action === 'update') {
        if (!/^[a-f0-9]{64}$/.test(item.previousSha256 ?? '')) throw new Error('Update plan lacks a verified pre-change content hash.');
        const previous = await device.read(item.target, { storageFile: item.storageFile });
        if (!Buffer.isBuffer(previous) || sha256(previous) !== item.previousSha256) throw new Error('Target content changed since preview; refusing stale update.');
      }
      if (!under(approvedPlan.workspaceRoot, item.source) || !under(approvedPlan.workspaceRoot, await realpath(item.source))) throw new Error('Source path escapes workspace.');
      const bytes = await readFile(item.source);
      if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error('Source changed since preview.');
      await device.write(item.target, bytes, { storageFile: item.storageFile, owner: item.owner, action: item.action, backupVerified, expectedSize: item.size, expectedSha256: item.sha256, expectedPreviousSha256: item.previousSha256, onState: state => { if (states.at(-1) !== state) states.push(state); } });
      const readback = await device.read(item.target, { storageFile: item.storageFile });
      if (!Buffer.isBuffer(readback) || sha256(readback) !== item.sha256) throw new Error('Committed content read-back verification failed.');
      if (!states.includes('verified')) states.push('verified');
      await recordOwnedFile(approvedPlan.workspaceRoot, item.target, item.owner, { verified: true });
      if (!states.includes('committed')) states.push('committed');
      results.push({ target: item.target, action: item.action, status: 'committed', states, sha256: item.sha256 });
    } catch (error) {
      const status = states.includes('committed') ? 'committed' : (error.transferState ?? 'failed');
      if (states.at(-1) !== status) states.push(status);
      results.push({ target: item.target, action: item.action, status, states, recoveryRequired: Boolean(error.recoveryRequired), error: error.message });
      break;
    }
  }
  return { complete: results.length === approvedPlan.plan.length && results.every(result => result.status === 'committed' && !result.error && !result.recoveryRequired), atomic: false, results };
}
