import { readFile } from 'node:fs/promises';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { safeName } from './core.js';
import { loadWorkspaceManifest } from './management.js';

const inside = (root, file) => { const rel = relative(resolve(root), resolve(file)); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
async function readMetadata(folder, id) {
  const directory = join(folder, id);
  try { return { directory, metadata: JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) }; } catch { return null; }
}
export async function compileProfile(workspaceRoot, profileId) {
  if (typeof profileId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profileId)) throw new Error('Invalid profile ID.');
  const root = resolve(workspaceRoot), profilePath = join(root, 'profiles', `${profileId}.json`);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  if (profile.schemaVersion !== 1 || profile.kind !== 'banglesync-profile' || profile.id !== profileId) throw new Error('Profile manifest is invalid or incompatible.');
  const ids = new Map();
  for (const id of [...(profile.apps ?? []), ...(profile.widgets ?? []), ...(profile.clock ? [profile.clock] : []), ...(profile.launcher ? [profile.launcher] : [])]) {
    const spec = typeof id === 'string' ? { id } : id;
    if (!spec || typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(spec.id)) throw new Error('Profile app references must be valid IDs or {id, source} entries.');
    ids.set(spec.id, spec.source ?? null);
  }
  const files = [], conflicts = [], appIds = [...ids.keys()];
  for (const [id, sourceChoice] of ids) {
    const custom = await readMetadata(join(root, 'BangleCustom', 'projects'), id);
    const upstream = await readMetadata(join(root, 'BangleApps', 'apps'), id);
    if (sourceChoice && !['custom', 'upstream'].includes(sourceChoice)) { conflicts.push({ id, reason: 'source must be custom or upstream' }); continue; }
    if (!custom && !upstream) { conflicts.push({ id, reason: 'application metadata not found in custom workspace or BangleApps baseline' }); continue; }
    if (custom && upstream && !sourceChoice) { conflicts.push({ id, reason: 'exists in both custom and upstream sources; specify source explicitly' }); continue; }
    const selected = sourceChoice === 'upstream' ? upstream : sourceChoice === 'custom' ? custom : custom ?? upstream;
    if (!selected || selected.metadata.id !== id || !Array.isArray(selected.metadata.storage)) { conflicts.push({ id, reason: 'invalid app metadata or storage list' }); continue; }
    for (const stored of selected.metadata.storage) {
      if (!safeName(stored?.name) || typeof stored.url !== 'string' || isAbsolute(stored.url) || stored.url.split(/[\\/]/).some(part => part === '..')) { conflicts.push({ id, reason: `unsafe storage metadata for ${stored?.name ?? 'file'}` }); continue; }
      const source = resolve(selected.directory, stored.url);
      if (!inside(selected.directory, source) || !inside(root, source)) { conflicts.push({ id, reason: `app file escapes workspace: ${stored.url}` }); continue; }
      files.push({ source: relative(root, source), target: stored.name, owner: `app:${id}`, application: id, storageFile: true });
    }
  }
  const behaviorIds = profile.behaviours ?? [], phoneProtocols = [];
  for (const id of behaviorIds) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) { conflicts.push({ behavior: String(id), reason: 'behavior references must be valid IDs' }); continue; }
    const path = join(root, 'behaviours', `${id}.json`);
    try {
      const behavior = JSON.parse(await readFile(path, 'utf8'));
      if (behavior.schemaVersion !== 1 || behavior.kind !== 'banglesync-behaviour' || !Array.isArray(behavior.files) || !Array.isArray(behavior.dependencies) || !Array.isArray(behavior.capabilities) || !Array.isArray(behavior.permissions) || !behavior.dependencies.every(x => typeof x === 'string') || !behavior.capabilities.every(x => typeof x === 'string') || !behavior.permissions.every(x => typeof x === 'string')) throw new Error('invalid behaviour manifest schema');
      if (behavior.phoneProtocol) {
        if (typeof behavior.phoneProtocol !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(behavior.phoneProtocol)) throw new Error('invalid phone protocol reference');
        const protocol = JSON.parse(await readFile(join(root, 'protocols', `${behavior.phoneProtocol}.json`), 'utf8'));
        if (protocol.schemaVersion !== 1 || protocol.kind !== 'banglesync-phone-protocol' || protocol.transport !== 'BLE' || !Array.isArray(protocol.messages) || !Array.isArray(protocol.compatibleCompanions)) throw new Error('invalid phone protocol manifest');
        for (const message of protocol.messages) {
          const validSchema = schema => schema && typeof schema === 'object' && !Array.isArray(schema) && schema.type === 'object' && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties);
          if (!message || typeof message.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(message.id) || !validSchema(message.request) || !validSchema(message.response)) throw new Error('invalid message ID or request/response schema');
        }
        phoneProtocols.push({ id: protocol.id, version: protocol.version, transport: protocol.transport, messages: protocol.messages, compatibleCompanions: protocol.compatibleCompanions, internetRequired: Boolean(protocol.connectivity?.internetRequired) });
      }
      for (const stored of behavior.files) {
        if (!safeName(stored?.target) || typeof stored.source !== 'string' || isAbsolute(stored.source) || stored.source.split(/[\\/]/).some(part => part === '..')) throw new Error('unsafe behavior file mapping');
        const source = resolve(root, 'behaviours', id, stored.source);
        if (!inside(root, source)) throw new Error('behavior source escapes workspace');
        files.push({ source: relative(root, source), target: stored.target, owner: `behaviour:${id}`, storageFile: true });
      }
    } catch (error) { conflicts.push({ behavior: id, reason: error.message }); }
  }
  if (profile.theme) {
    try {
      const theme = JSON.parse(await readFile(join(root, 'themes', `${profile.theme}.json`), 'utf8'));
      if (theme.schemaVersion !== 1 || theme.kind !== 'banglesync-theme' || !Array.isArray(theme.compatibility?.applications)) throw new Error('invalid theme manifest');
      const compatible = theme.compatibility.applications;
      const incompatible = appIds.filter(id => !compatible.includes(id));
      if (incompatible.length) conflicts.push({ theme: profile.theme, reason: 'theme is not declared compatible with every selected application', incompatibleApplications: incompatible });
    } catch { conflicts.push({ theme: profile.theme, reason: 'theme manifest is missing or invalid' }); }
  }
  const stagedSettings = {};
  if (profile.settings && (typeof profile.settings !== 'object' || Array.isArray(profile.settings))) conflicts.push({ settings: null, reason: 'profile settings must be grouped by allowlisted filename' });
  else if (Object.keys(profile.settings ?? {}).length) {
    let registry = { settings: [] };
    try { registry = JSON.parse(await readFile(join(root, 'config', 'registry.json'), 'utf8')); } catch { conflicts.push({ settings: null, reason: 'device settings registry is missing or invalid' }); }
    for (const [file, values] of Object.entries(profile.settings)) {
      if (!['setting.json', 'wid_settings.json'].includes(file) || !values || typeof values !== 'object' || Array.isArray(values)) { conflicts.push({ settings: file, reason: 'settings must use an allowlisted JSON file and key/value object' }); continue; }
      for (const [key, value] of Object.entries(values)) {
        const definition = registry.settings?.find(item => item.file === file && item.key === key);
        const valid = definition && ((definition.type === 'boolean' && typeof value === 'boolean') || (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (definition.type === 'string' && typeof value === 'string' && value.length <= 1024));
        if (!valid) conflicts.push({ settings: `${file}:${key}`, reason: 'setting is not registered with a matching value type' });
        else { stagedSettings[file] ??= {}; stagedSettings[file][key] = value; }
      }
    }
  }
  const targets = new Set();
  for (const item of files) { if (targets.has(item.target)) conflicts.push({ target: item.target, reason: 'two selected components claim the same device filename' }); targets.add(item.target); }
  const workspaceManifest = await loadWorkspaceManifest(root);
  const ownership = Object.fromEntries(Object.entries(workspaceManifest.ownership).filter(([name]) => targets.has(name)));
  return { schemaVersion: 1, kind: 'banglesync-desired-state', profile: profileId, files, ownership, phoneProtocols, settings: stagedSettings, conflicts, appliesThemeUniversally: false, settingsApplied: false, applicable: conflicts.length === 0 };
}
