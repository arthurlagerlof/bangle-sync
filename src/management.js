import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { safeName, classifyDeviceFile as classifyCore } from './core.js';

export const MANAGED_DIRS = ['apps', 'themes', 'behaviours', 'profiles', 'config', 'protocols', 'manifests'];
const CONFIG_ALLOWLIST = new Set(['setting.json', 'setting.js', 'wid_settings.json']);
const validOwner = owner => typeof owner === 'string' && /^(?:app|behaviour):[a-z0-9][a-z0-9_-]{0,39}$/.test(owner);

export function classifyDeviceFile(file, ownership = {}) {
  const name = file?.name;
  const result = classifyCore(name, {
    owned: new Set(Object.keys(ownership)),
    allowlistedConfiguration: CONFIG_ALLOWLIST.has(name),
    knownApplication: Boolean(file?.application || file?.applicationCandidates?.length)
  });
  return { ...result, ...(result.classification === 'banglesync-managed' ? { owner: ownership[name] } : {}), ...(result.classification === 'known-application' ? { owner: file.application } : {}) };
}

export function assertManagedTarget(name, { ownership = {}, operation = 'update', exists = true, owner } = {}) {
  if (!safeName(name)) throw new Error('Unsafe device filename; path traversal and invalid names are refused.');
  const classification = classifyDeviceFile({ name }, ownership);
  if (classification.classification === 'protected-system') throw new Error(`Refusing ${operation} of protected system file '${name}'.`);
  if (operation === 'create') {
    if (exists || classification.classification === 'allowlisted-configuration') throw new Error(`Refusing create for existing or configuration file '${name}'.`);
    if (!validOwner(owner)) throw new Error('New device files require an explicit app:<id> or behaviour:<id> owner.');
    return classification;
  }
  if (classification.classification !== 'banglesync-managed' || ownership[name] !== owner) throw new Error(`Refusing ${operation} of file '${name}' without matching BangleSync ownership.`);
  if (operation === 'delete') throw new Error('Deletion is not implemented.');
  if (!['update', 'write'].includes(operation)) throw new Error(`Unsupported device-file operation '${operation}'.`);
  return classification;
}

export async function loadWorkspaceManifest(root) {
  const path = join(root, 'manifests', 'workspace.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, kind: 'banglesync-workspace', ownership: {}, sources: { bangleApps: null }, profiles: [] }; throw error; }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'banglesync-workspace' || !manifest.ownership || typeof manifest.ownership !== 'object' || Array.isArray(manifest.ownership)) throw new Error('Invalid BangleSync workspace ownership manifest.');
  const ownership = {};
  for (const [name, owner] of Object.entries(manifest.ownership)) {
    if (classifyDeviceFile({ name }).classification !== 'protected-system' && validOwner(owner)) ownership[name] = owner;
  }
  return { ...manifest, ownership };
}

export async function recordOwnedFile(root, name, owner, { verified = false } = {}) {
  if (!verified) throw new Error('Ownership can only be recorded after an explicitly approved and verified upload.');
  if (!validOwner(owner)) throw new Error('Owner must be an explicit app:<id> or behaviour:<id> component.');
  const classification = classifyDeviceFile({ name });
  if (classification.classification === 'protected-system') throw new Error(`Protected target cannot be registered: ${name}`);
  await initializeManagedWorkspace(root);
  const manifest = await loadWorkspaceManifest(root);
  manifest.ownership[name] = owner;
  await writeFile(join(root, 'manifests', 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.ownership;
}

export async function initializeManagedWorkspace(root) {
  for (const dir of MANAGED_DIRS) await mkdir(join(root, dir), { recursive: true });
  const initialFiles = [
    [join(root, 'manifests', 'workspace.json'), { schemaVersion: 1, kind: 'banglesync-workspace', ownership: {}, sources: { bangleApps: null }, profiles: [] }],
    [join(root, 'config', 'registry.json'), { schemaVersion: 1, kind: 'banglesync-settings-registry', settings: [] }]
  ];
  for (const [path, value] of initialFiles) {
    try { await readFile(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    }
  }
  return { root: resolve(root), directories: MANAGED_DIRS };
}

const idPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
function validId(id) { if (!idPattern.test(id)) throw new Error('ID must use lowercase letters, digits, hyphens or underscores (max 40 characters).'); }
async function entries(root, dir) {
  const names = await readdir(join(root, dir)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const result = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { result.push(JSON.parse(await readFile(join(root, dir, name), 'utf8'))); } catch { result.push({ id: name.slice(0, -5), invalid: true }); }
  }
  return result;
}
export async function createTheme(root, id) {
  validId(id); await initializeManagedWorkspace(root);
  const file = join(root, 'themes', `${id}.json`);
  const value = { schemaVersion: 1, kind: 'banglesync-theme', id, compatibility: { applications: [], apiVersion: 1 }, visual: { foreground: '#ffffff', background: '#000000', accent: '#00aaff', font: 'Vector' }, note: 'Themes affect only applications that explicitly support this format.' };
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); return { file, ...value };
}
export async function createBehaviour(root, id) {
  validId(id); if (id.length > 25) throw new Error('Behaviour ID must be at most 25 characters to fit the Bangle Storage filename limit.'); await initializeManagedWorkspace(root);
  const file = join(root, 'behaviours', `${id}.json`), directory = join(root, 'behaviours', id);
  try { await readFile(file); throw new Error(`Behaviour '${id}' already exists; refusing to overwrite it.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const value = { schemaVersion: 1, kind: 'banglesync-behaviour', id, version: '1.0.0', entry: 'index.js', dependencies: [], capabilities: ['event-listener'], permissions: ['Bangle.on', 'Bangle.removeListener'], phoneProtocol: null, files: [{ source: 'index.js', target: `${id}.js`, storageFile: true }], warning: 'Bangle.js apps may share a JavaScript environment; this module must be explicitly loaded by a compatible app and is not an OS sandbox.' };
  await mkdir(directory, { recursive: false });
  const code = 'exports.install = function (onTouch) {\n  if (typeof onTouch !== "function") throw new Error("onTouch callback is required");\n  function handleTouch(button, xy) { onTouch(button, xy); }\n  Bangle.on("touch", handleTouch);\n  return function uninstall() { Bangle.removeListener("touch", handleTouch); };\n};\n';
  await writeFile(join(directory, 'index.js'), code, { flag: 'wx' });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); return { file, source: join(directory, 'index.js'), ...value };
}
export async function listManaged(root, category) {
  const map = { theme: 'themes', behaviour: 'behaviours', profile: 'profiles', app: 'apps', config: 'config', protocol: 'protocols' };
  if (!map[category]) throw new Error(`Unsupported category '${category}'.`);
  return entries(root, map[category]);
}
export async function createProtocol(root, id) {
  validId(id); await initializeManagedWorkspace(root);
  const file = join(root, 'protocols', `${id}.json`);
  const protocol = { schemaVersion: 1, kind: 'banglesync-phone-protocol', id, version: '1.0.0', transport: 'BLE', messages: [], compatibleCompanions: [], connectivity: { internetRequired: false }, note: 'Protocol definition only; no Android companion is included.' };
  await writeFile(file, `${JSON.stringify(protocol, null, 2)}\n`, { flag: 'wx' }); return { file, ...protocol };
}
export async function createProfile(root, id) {
  validId(id); await initializeManagedWorkspace(root);
  const file = join(root, 'profiles', `${id}.json`);
  const profile = { schemaVersion: 1, kind: 'banglesync-profile', id, apps: [], clock: null, launcher: null, widgets: [], theme: null, behaviours: [], settings: {}, note: 'Applying a profile creates a preview; it does not write to a device.' };
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' }); return { file, ...profile };
}
