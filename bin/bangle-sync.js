#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { SimulatedDevice, createBackup, verifyBackup, safeName } from '../src/core.js';
import { createApp, workspaceDiff, workspaceStatus, updateUpstream } from '../src/workspace.js';
import { initializeManagedWorkspace, createTheme, createBehaviour, createProfile, createProtocol, listManaged, classifyDeviceFile, loadWorkspaceManifest } from '../src/management.js';
import { createManagedBackup, createBackupFromImport, verifyManagedBackup } from '../src/managed-backup.js';
import { planSync, applySyncPlan, syncPlanHash } from '../src/sync-engine.js';
import { loadAppCatalog, associateApplication } from '../src/app-catalog.js';
import { compileProfile } from '../src/profile-planner.js';
import { EspruinoCliAdapter } from '../src/espruino-cli-adapter.js';
import { registerDeviceSetting, setDesiredDeviceSetting, listDeviceSettings } from '../src/settings-registry.js';
const exec = promisify(execFile);
export const VERSION = '0.2.0';
export const CONFIG_NAME = 'bangle-sync.json';
export function starterConfig() { return { schemaVersion: 1, project: { name: 'my-bangle-project' }, sources: [], devices: {}, backup: { directory: join(homedir(), 'BangleSync-Device-Backups') } }; }
export function usage() { return `bangle-sync ${VERSION}\n\nUsage: bangle-sync <command> [options]\n\nCommands:\n  init         Create starter configuration\n  workspace    status | diff | import-device | update-upstream\n  app create|list  Create or list workspace applications\n  theme create|list  Manage compatible theme manifests\n  behaviour create|list  Manage declared behaviour packages\n  profile create|list|plan|apply  Manage and preview desired-state profiles\n  phone protocol create|list  Define phone BLE protocol metadata\n  config       Manage backup, transport, and explicitly registered setting keys\n  device discover|info|inventory|backup|diff|update|launch|show-clock  Use EspruinoTools subprocess
    device backup --pull  Compare the pinned Git baseline and pull the scoped watch diff\n  backup list  List backup manifests\n  connect      Connect to a simulated device (--simulate)\n  info         Show simulated device information (--simulate)\n  inventory    List simulated Storage files (--simulate)\n  backup       Create a logical Storage backup (--simulate --destination <dir>)\n  verify       Verify a backup directory (--path <dir>)\n  pull         Retrieve one simulated file (--simulate --name <file>)\n  status       Show device/backup status (--simulate)\n  diff         Compare a simulated inventory with a backup (--simulate --backup <dir>)\n  sync         Preview with --dry-run; apply requires --confirm and --plan-hash\n  push/deploy  Disabled legacy commands; use the guarded sync workflow\n\nPhysical commands use the EspruinoTools subprocess adapter and have limited hardware qualification; --simulate never contacts a watch.\n` }
const json = (o, value) => o.log(JSON.stringify(value, null, 2));
async function findWorkspace(cwd) {
  let directory = resolve(cwd);
  for (;;) {
    try { await readFile(resolve(directory, CONFIG_NAME), 'utf8'); return directory; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = resolve(directory, '..');
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}
async function config(cwd) { try { return JSON.parse(await readFile(resolve(await findWorkspace(cwd), CONFIG_NAME), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return starterConfig(); throw error; } }
const backupDirectory = value => value === undefined ? starterConfig().backup.directory : value;
export async function deviceCatalog(workspace, requestedAppIds = []) {
  const manifest = await loadWorkspaceManifest(workspace), settings = await listDeviceSettings(workspace);
  let desired = { files: [] };
  try { desired = JSON.parse(await readFile(join(workspace, 'manifests', 'desired.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const activeFiles = Array.isArray(desired.files) ? desired.files : [];
  const requested = new Set(requestedAppIds.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id))), appIds = new Set(requested);
  const activeScope = activeFiles.filter(file => { const id = typeof file?.application === 'string' ? file.application : /^app:([a-z0-9][a-z0-9_-]{0,39})$/.exec(file?.owner)?.[1]; return requested.size === 0 || (id && requested.has(id)); });
  const declaredTargets = new Set(activeScope.filter(file => file && typeof file.target === 'string').map(file => file.target)), inlineFiles = new Set();
  for (const file of activeScope) {
    const id = typeof file.application === 'string' ? file.application : /^app:([a-z0-9][a-z0-9_-]{0,39})$/.exec(file.owner)?.[1];
    if (id) appIds.add(id);
    if (typeof file.source === 'string') {
      const source = resolve(workspace, file.source), rel = relative(resolve(workspace), source);
      if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) { try { if ((await stat(source)).size <= 4096) inlineFiles.add(file.target); } catch {} }
    }
  }
  const [upstream, custom] = await Promise.all([loadAppCatalog(join(workspace, 'BangleApps'), { appIds: [...appIds] }), loadAppCatalog(join(workspace, 'BangleCustom', 'projects'), { direct: true, appIds: [...appIds] })]);
  const selectedUpstream = upstream.apps, selectedCustom = custom.apps;
  const applications = {}, localSources = {}, baselinePaths = {};
  for (const app of selectedUpstream) for (const file of app.files) {
    declaredTargets.add(file.name);
    if (Number.isSafeInteger(file.size) && file.size <= 4096) inlineFiles.add(file.name);
    if (!applications[file.name]) applications[file.name] = [];
    applications[file.name].push(app.id);
    const reference = (upstream.baselineByStorageName[file.name] ?? []).find(item => item.appId === app.id);
    if (reference) { if (!baselinePaths[file.name]) baselinePaths[file.name] = []; baselinePaths[file.name].push(reference); }
  }
  for (const app of selectedCustom) for (const file of app.files) {
    declaredTargets.add(file.name);
    if (Number.isSafeInteger(file.size) && file.size <= 4096) inlineFiles.add(file.name);
    if (!applications[file.name]) applications[file.name] = [];
    applications[file.name].push(app.id);
    if (!localSources[file.name]) localSources[file.name] = [];
    localSources[file.name].push({ appId: app.id, source: join('BangleCustom', 'projects', app.id, file.url) });
  }
  for (const name of Object.keys(manifest.ownership)) declaredTargets.add(name);
  for (const item of settings.registry) declaredTargets.add(item.file);
  for (const name of await readdir(join(workspace, 'BangleCustom', 'device-imports')).catch(() => [])) {
    try {
      const imported = JSON.parse(await readFile(join(workspace, 'BangleCustom', 'device-imports', name, 'manifest.json'), 'utf8'));
      if (requested.size === 0) for (const file of imported.scopeFiles ?? []) if (typeof file === 'string') declaredTargets.add(file);
      for (const file of imported.files ?? []) if (typeof file.name === 'string' && (requested.size === 0 || requested.has(file.application))) declaredTargets.add(file.name);
      for (const file of imported.snapshotFiles ?? []) {
        if (typeof file.name !== 'string' || (requested.size > 0 && !requested.has(file.application))) continue;
        declaredTargets.add(file.name);
        if (Number.isSafeInteger(file.size) && file.size <= 4096) inlineFiles.add(file.name);
        if (typeof file.application === 'string') { if (!applications[file.name]) applications[file.name] = []; applications[file.name].push(file.application); }
        if (file.baseline?.source === 'upstream' && file.baseline.path) { if (!baselinePaths[file.name]) baselinePaths[file.name] = []; baselinePaths[file.name].push({ repositoryPath: file.baseline.path, appId: file.application }); }
      }
    } catch {}
  }
  let upstreamPin = null;
  try {
    await stat(join(workspace, 'BangleApps', '.git'));
    const [{ stdout: commit }, { stdout: repository }] = await Promise.all([exec('git', ['-C', join(workspace, 'BangleApps'), 'rev-parse', 'HEAD']), exec('git', ['-C', join(workspace, 'BangleApps'), 'remote', 'get-url', 'origin'])]);
    upstreamPin = { commit: commit.trim(), repository: repository.trim() };
  } catch {}
  for (const name of Object.keys(applications)) applications[name] = [...new Set(applications[name])];
  for (const name of Object.keys(baselinePaths)) baselinePaths[name] = [...new Map(baselinePaths[name].map(reference => [`${reference.appId}:${reference.repositoryPath}`, reference])).values()];
  const knownFiles = [...declaredTargets].filter(name => classifyDeviceFile({ name }, manifest.ownership).classification !== 'protected-system');
  return { upstream, custom, manifest, settings, desired, appIds: [...appIds], applications, localSources, upstreamPin, baselinePaths, knownFiles, inlineFiles: [...inlineFiles] };
}
function outsideWorkspace(directory, cwd) { const target = resolve(directory), root = resolve(cwd), rel = relative(root, target); if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('Backup destination must be outside the project workspace'); return target; }

export async function run(args, cwd = process.cwd(), output = console) {
  if (args[0] === 'device' && args[1] === 'update') {
    const updateOptions = args.slice(2);
    if (!updateOptions.includes('--dry-run') && !updateOptions.includes('--apply')) {
      output.error('Use device update --dry-run to preview, or device update --apply --confirm --plan-hash <hash> to apply a reviewed plan.'); return 2;
    }
    return run(['sync', ...updateOptions], cwd, output);
  }
  const [command, ...opts] = args; const has = x => opts.includes(x); const val = x => { const i = opts.indexOf(x); return i < 0 ? undefined : opts[i + 1]; }; const vals = x => opts.flatMap((item, i) => item === x && opts[i + 1] && !opts[i + 1].startsWith('--') ? [opts[i + 1]] : []);
  if (!command || command === '--help' || command === '-h' || has('--help') || has('-h')) { output.log(usage()); return 0; }
  if (command === '--version' || has('--version') || has('-v')) { output.log(VERSION); return 0; }
  if (command === 'backup' && opts[0] === 'list') {
    const root = resolve(val('--destination') || (await config(cwd)).backup?.directory || backupDirectory()), rows = [];
    try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) { const directory = join(root, entry.name); try { const manifestBytes = await readFile(join(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString('utf8')); if (manifest.kind === 'banglesync-device-import') { const seal = (await readFile(join(directory, 'manifest.sha256'), 'utf8')).trim(), valid = createHash('sha256').update(manifestBytes).digest('hex') === seal && manifest.snapshotComplete === true && Array.isArray(manifest.snapshotFiles) && manifest.snapshotFiles.length === manifest.scopeFiles?.length; rows.push({ directory, mode: 'comparison-diff', createdAt: manifest.createdAt, state: valid ? 'COMPLETE_AND_VERIFIED' : 'INCOMPLETE' }); } else { const check = await verifyManagedBackup(directory); rows.push({ directory, mode: manifest.mode, createdAt: manifest.createdAt, state: check.complete ? 'COMPLETE_AND_VERIFIED' : 'INCOMPLETE' }); } } catch { rows.push({ directory, state: 'INCOMPLETE_OR_UNSEALED' }); } } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    json(output, rows.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))); return 0;
  }
  if (command === 'init') { const p = resolve(cwd, CONFIG_NAME); try { await readFile(p); output.error(`${CONFIG_NAME} already exists; refusing to overwrite it.`); return 1; } catch (e) { if (e.code !== 'ENOENT') throw e; } await writeFile(p, `${JSON.stringify(starterConfig(), null, 2)}\n`, { flag: 'wx' }); await initializeManagedWorkspace(cwd); output.log(`Created ${CONFIG_NAME} and managed workspace directories.`); return 0; }
  if (command === 'workspace') {
    const root = val('--path') || await findWorkspace(cwd), action = opts[0];
    if (action === 'status') { json(output, await workspaceStatus(root)); return 0; }
    if (action === 'diff') { json(output, await workspaceDiff(root)); return 0; }
    if (action === 'import-device') { output.error('Real-device import is blocked: no verified BLE transport is available. No device was contacted.'); return 2; }
    if (action === 'update-upstream') { json(output, await updateUpstream(root)); return 0; }
    output.error('Usage: workspace status|diff|update-upstream [--path <workspace>]'); return 2;
  }
  if (command === 'phone' && opts[0] === 'protocol' && ['create', 'list'].includes(opts[1])) {
    const root = val('--path') || await findWorkspace(cwd); await initializeManagedWorkspace(root);
    if (opts[1] === 'list') { json(output, await listManaged(root, 'protocol')); return 0; }
    if (!opts[2]) { output.error('Usage: phone protocol create <id>'); return 2; }
    json(output, await createProtocol(root, opts[2])); return 0;
  }
  if (command === 'profile' && ['plan', 'apply'].includes(opts[0])) {
    const root = val('--path') || await findWorkspace(cwd), id = opts[1];
    if (!id) { output.error(`Usage: profile ${opts[0]} <id>`); return 2; }
    await initializeManagedWorkspace(root);
    const desired = await compileProfile(root, id);
    if (desired.conflicts.length) { json(output, { desired, applicable: false }); return 1; }
    const preview = await planSync({ workspaceRoot: root, device: new SimulatedDevice(), desiredFiles: desired.files, ownership: desired.ownership, backupVerified: false });
    if (!preview.applicable) { json(output, { profile: id, desiredStateSaved: false, preview, note: 'Resolve conflicts before saving or applying this profile.' }); return 1; }
    if (opts[0] === 'apply') await writeFile(join(root, 'manifests', 'desired.json'), `${JSON.stringify({ ...desired, files: desired.files }, null, 2)}\n`, { flag: 'w' });
    json(output, { profile: id, desiredStateSaved: opts[0] === 'apply', stagedSettings: desired.settings, settingsApplied: false, preview, note: 'This operation does not contact or modify a physical device; setting values are staged only.' }); return 0;
  }
  if ((['theme', 'behaviour', 'profile'].includes(command) && ['create', 'list'].includes(opts[0])) || (command === 'app' && opts[0] === 'list')) {
    const root = val('--path') || await findWorkspace(cwd), category = command === 'behaviour' ? 'behaviour' : command;
    await initializeManagedWorkspace(root);
    if (opts[0] === 'list') {
      if (command === 'app' && val('--source') === 'upstream') { json(output, await loadAppCatalog(join(root, 'BangleApps'))); return 0; }
      if (command === 'app') {
        const projects = join(root, 'BangleCustom', 'projects'); const ids = await readdir(projects).catch(() => []); const apps = [];
        for (const id of ids) { try { apps.push(JSON.parse(await readFile(join(projects, id, 'metadata.json'), 'utf8'))); } catch { apps.push({ id, status: 'invalid-or-missing-metadata' }); } }
        json(output, apps); return 0;
      }
      json(output, await listManaged(root, category)); return 0;
    }
    const id = opts[1]; if (!id) { output.error(`Usage: ${command} create <id>`); return 2; }
    const result = command === 'theme' ? await createTheme(root, id) : command === 'behaviour' ? await createBehaviour(root, id) : command === 'profile' ? await createProfile(root, id) : null;
    if (command === 'app') { output.error('Use app create <id> [--type standard|clock|widget].'); return 2; }
    json(output, result); return 0;
  }
  if (command === 'app' && opts[0] === 'create') {
    const id = opts[1], type = val('--type') || 'standard';
    if (!id) { output.error('Usage: app create <id> [--type standard|clock|widget]'); return 2; }
    json(output, await createApp(val('--path') || await findWorkspace(cwd), id, type)); return 0;
  }
  if (command === 'config') {
    const workspace = val('--path') || await findWorkspace(cwd), c = await config(workspace), action = opts[0], key = opts[1];
    if (action === 'list') { json(output, { ...await listDeviceSettings(workspace), hostSettings: ['backup.directory', 'transport.espruinoPath'], allowlistedDeviceFiles: ['setting.json', 'wid_settings.json'] }); return 0; }
    if (action === 'register-device') { try { json(output, await registerDeviceSetting(workspace, opts[1], opts[2], val('--type'))); return 0; } catch (error) { output.error(error.message); return 2; } }
    if (action === 'set-device') { if (opts.length < 4) { output.error('Usage: config set-device <setting.json|wid_settings.json> <key> <value>'); return 2; } try { json(output, await setDesiredDeviceSetting(workspace, opts[1], opts[2], opts.slice(3).join(' '))); return 0; } catch (error) { output.error(error.message); return 2; } }
    if (!['get', 'set'].includes(action) || !['backup.directory', 'transport.espruinoPath'].includes(key)) { output.error('Usage: config list | config register-device <setting.json|wid_settings.json> <key> --type <boolean|number|string> | config set-device <file> <key> <value> | config get|set backup.directory|transport.espruinoPath [value]'); return 2; }
    if (action === 'get') { output.log(key === 'backup.directory' ? (c.backup?.directory ?? backupDirectory()) : (c.transport?.espruinoPath ?? '(bundled EspruinoTools CLI)')); return 0; }
    const value = opts.slice(2).join(' '); if (!value) { output.error(`${key} must be a non-empty value.`); return 2; }
    if (key === 'backup.directory') { if (!isAbsolute(value)) { output.error('Backup directory must be an absolute path.'); return 2; } c.backup = { ...(c.backup || {}), directory: resolve(value) }; }
    else c.transport = { ...(c.transport || {}), espruinoPath: value };
    await writeFile(resolve(workspace, CONFIG_NAME), `${JSON.stringify(c, null, 2)}\n`, { flag: 'w' }); output.log(`${key} set.`); return 0;
  }
  if (command === 'device') {
    const action = opts[0], workspace = val('--path') || await findWorkspace(cwd);
    if (action === 'diff' && val('--from-import')) {
      const source = resolve(cwd, val('--from-import')), manifestBytes = await readFile(join(source, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestBytes), seal = (await readFile(join(source, 'manifest.sha256'), 'utf8')).trim();
      if (createHash('sha256').update(manifestBytes).digest('hex') !== seal || manifest.kind !== 'banglesync-device-import' || manifest.snapshotComplete !== true || !Array.isArray(manifest.snapshotFiles) || !Array.isArray(manifest.scopeFiles) || manifest.snapshotFiles.length !== manifest.scopeFiles.length) throw new Error('Cached device import is incomplete or failed manifest verification.');
      const files = [];
      for (const item of manifest.snapshotFiles) {
        if (!safeName(item.name)) throw new Error('Cached snapshot contains an unsafe filename.');
        const bytes = await readFile(join(source, 'snapshot', item.name)), deviceHash = createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== item.size || deviceHash !== item.sha256) throw new Error(`Cached snapshot integrity check failed for ${item.name}.`);
        let baselineHash = null;
        if (item.baseline?.source === 'upstream') {
          if (item.baseline.commit !== manifest.baseline?.commit || item.baseline.repository !== manifest.baseline?.repository) throw new Error(`Pinned baseline metadata mismatch for ${item.name}.`);
          const upstreamRoot = resolve(workspace, 'BangleApps'), baselinePath = resolve(upstreamRoot, item.baseline.path), rel = relative(upstreamRoot, baselinePath);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Cached baseline path escapes the upstream clone.');
          const baseline = await exec('git', ['-C', upstreamRoot, 'show', `${item.baseline.commit}:${item.baseline.path}`], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
          baselineHash = createHash('sha256').update(baseline.stdout).digest('hex');
        } else if (item.baseline?.source === 'custom-workspace') {
          const localPath = resolve(workspace, item.baseline.path), localRel = relative(resolve(workspace), localPath);
          if (localRel === '..' || localRel.startsWith(`..${sep}`) || isAbsolute(localRel)) throw new Error('Cached custom path escapes the workspace.');
          const local = await readFile(localPath);
          baselineHash = createHash('sha256').update(local).digest('hex');
          if (baselineHash !== item.baseline.sha256) throw new Error(`Pinned custom file verification failed for ${item.name}.`);
        }
        const status = baselineHash === null ? 'device-only-or-unbaselined' : baselineHash === deviceHash ? 'identical-to-baseline' : 'device-modified-vs-baseline';
        files.push({ name: item.name, application: item.application, status, size: bytes.length, sha256: deviceHash });
      }
      json(output, { source: 'cached-device-snapshot', scope: manifest.scope, baseline: manifest.baseline, files, note: 'No BLE connection or device read performed; cache represents the time of the recorded import.' }); return 0;
    }
    if (!['discover', 'info', 'connect', 'inventory', 'diff', 'backup', 'launch', 'show-clock'].includes(action)) { output.error('Usage: device discover|info|inventory|diff|backup|launch|show-clock [--device-index N]'); return 2; }
    if (action === 'discover' && !has('--simulate')) {
      const adapter = new EspruinoCliAdapter({ executable: (await config(workspace)).transport?.espruinoPath || null });
      const devices = await adapter.discover(); json(output, devices.map((device, index) => ({ index: index + 1, name: 'Bangle.js device', transport: device.transport })));
      return devices.length ? 0 : 1;
    }
    if (action === 'backup' && val('--from-import')) {
      const c = await config(workspace), destination = outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), workspace);
      const result = await createBackupFromImport(resolve(cwd, val('--from-import')), destination);
      json(output, { ...result, destination, source: 'verified catalogued-user-files import; no device access performed' }); return result.manifest.complete ? 0 : 1;
    }
    if (!has('--simulate')) {
      const pullDiff = action === 'diff' || (action === 'backup' && has('--pull'));
      const catalog = await deviceCatalog(workspace, pullDiff ? vals('--app') : []);
      const adapter = new EspruinoCliAdapter({ executable: (await config(workspace)).transport?.espruinoPath || null, ownership: catalog.manifest.ownership, applications: catalog.applications, baselinePaths: catalog.baselinePaths, knownFiles: catalog.knownFiles, inlineFiles: catalog.inlineFiles });
      const devices = await adapter.discover(), index = Number(val('--device-index')) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= devices.length) { output.error(`Select a discovered device with --device-index 1..${devices.length}. Device identifiers are not printed.`); return 2; }
      try {
        const info = await adapter.connect(devices[index].id);
        if (action === 'info' || action === 'connect') { json(output, info); return 0; }
        if (action === 'backup' && !has('--pull')) {
          const c = await config(workspace), destination = outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), workspace);
          const backup = await createManagedBackup(adapter, destination, { mode: has('--full') ? 'full' : 'differential', forceFull: has('--full'), ownership: catalog.manifest.ownership });
          const verification = backup.manifest.complete ? await verifyManagedBackup(backup.dir) : { complete: false };
          json(output, { ...backup, destination, verification, note: 'Only catalogued managed user files are read; this is not a device-wide backup.' });
          return verification.complete ? 0 : 1;
        }
        if (action === 'launch') { if (!val('--app')) { output.error('Usage: device launch --app <owned-app-id> --confirm --device-index N'); return 2; } json(output, await adapter.launchApp(val('--app'), { confirm: has('--confirm') })); return 0; }
        if (action === 'show-clock') { json(output, await adapter.showClock()); return 0; }
        if (action === 'inventory') {
          const files = await adapter.inventory(), ownership = (await loadWorkspaceManifest(workspace)).ownership;
          json(output, { complete: false, metadataComplete: true, contentVerified: false, scope: 'catalogued-user-files-only', source: 'EspruinoTools subprocess', device: info, files: files.map(file => ({ ...file, ...classifyDeviceFile(file, ownership) })), note: 'Only catalog-declared user filenames were probed with one-byte existence reads; no global Storage listing or low-level files were queried.' }); return 0;
        }
        if (pullDiff) {
          if (!catalog.upstreamPin) { output.error('BangleApps is not a Git checkout with an origin; update the upstream clone before comparing.'); return 2; }
          const upstreamStatus = await exec('git', ['-C', join(workspace, 'BangleApps'), 'status', '--porcelain']);
          if (upstreamStatus.stdout.trim()) { output.error('BangleApps has local changes; refusing to compare against an unpinned working tree.'); return 2; }
          const inventory = await adapter.inventory(), appFilters = vals('--app'), files = appFilters.length ? inventory.filter(item => appFilters.some(id => item.application === id || item.applicationCandidates?.includes(id))) : inventory, results = [], changed = [], snapshot = [];
          let processed = 0;
          for (const item of files) {
            output.log(`Diff progress: ${++processed}/${files.length} catalogued user files.`);
            const data = await adapter.read(item.name, { storageFile: item.storageFile }), sha256 = createHash('sha256').update(data).digest('hex');
            let reference = null;
            const baselinePaths = catalog.baselinePaths[item.name] ?? [];
            if (baselinePaths.length === 1) {
              const baselineFile = await exec('git', ['-C', join(workspace, 'BangleApps'), 'show', `${catalog.upstreamPin.commit}:${baselinePaths[0].repositoryPath}`], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
              reference = { source: 'upstream', commit: catalog.upstreamPin.commit, repository: catalog.upstreamPin.repository, path: baselinePaths[0].repositoryPath, sha256: createHash('sha256').update(baselineFile.stdout).digest('hex') };
            } else if (baselinePaths.length === 0 && catalog.localSources[item.name]?.length === 1) {
              const local = await readFile(resolve(workspace, catalog.localSources[item.name][0].source));
              reference = { source: 'custom-workspace', path: catalog.localSources[item.name][0].source, sha256: createHash('sha256').update(local).digest('hex') };
            }
            const status = !reference ? 'device-only-or-unbaselined' : reference.sha256 === sha256 ? 'identical' : 'device-modified';
            const result = { name: item.name, storageFile: item.storageFile, application: item.application, classification: item.classification, status, size: data.length, sha256, reference };
            results.push(result); snapshot.push({ item, data, result }); if (status !== 'identical') changed.push({ item, data, result });
          }
          let imported = null;
          if (has('--pull') && snapshot.length) {
            const c = await config(workspace), backupRoot = outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), workspace);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-'), directory = join(backupRoot, stamp), filesDir = join(directory, 'files'), snapshotDir = join(directory, 'snapshot');
            await mkdir(filesDir, { recursive: true }); await mkdir(snapshotDir, { recursive: true });
            for (const record of snapshot) await writeFile(join(snapshotDir, record.item.name), record.data, { flag: 'wx' });
            for (const change of changed) await writeFile(join(filesDir, change.item.name), change.data, { flag: 'wx' });
            const snapshotFiles = snapshot.map(({ item, result }) => ({ name: result.name, storageFile: result.storageFile, application: result.application, classification: result.classification, size: result.size, sha256: result.sha256, owner: item.owner ?? (item.application ? `app:${item.application}` : null), baseline: result.reference }));
            const manifest = { schemaVersion: 1, kind: 'banglesync-device-import', createdAt: new Date().toISOString(), baseline: catalog.upstreamPin, scope: 'selected-catalogued-user-files-only', snapshotComplete: true, scopeFiles: snapshotFiles.map(file => file.name), snapshotFiles, device: { identity: 'not recorded', firmware: 'not inspected' }, files: changed.map(({ item, result }) => ({ ...result, owner: item.owner ?? (item.application ? `app:${item.application}` : null) })) };
            const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
            await writeFile(join(directory, 'manifest.json'), manifestBytes, { flag: 'wx' });
            await writeFile(join(directory, 'manifest.sha256'), `${createHash('sha256').update(manifestBytes).digest('hex')}\n`, { flag: 'wx' }); imported = directory;
          }
          json(output, { scope: 'catalogued-user-files-only', baseline: catalog.upstreamPin, compared: results.length, identical: results.filter(item => item.status === 'identical').length, differences: changed.map(({ result }) => result), importedTo: imported, pullRequested: has('--pull'), note: 'No unrecognized or low-level files were enumerated, queried, or downloaded; imports are separate from BangleApps.' }); return 0;
        }
        if (action === 'backup') {
          if (has('--include-unknown')) { output.error('Unknown-file capture is disabled: only catalogued and explicitly registered user files are queried.'); return 2; }
          const c = await config(cwd), forceFull = has('--full');
          const destination = outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), workspace);
          const result = await createManagedBackup(adapter, destination, { forceFull, ownership: catalog.manifest.ownership, onProgress: progress => output.log(`Backup progress: ${progress.completed}/${progress.total} catalogued user files.`) });
          json(output, { ...result, transport: 'EspruinoTools subprocess; hardware behavior is not qualified' }); return result.manifest.complete ? 0 : 1;
        }
        output.error('Usage: device discover|info|inventory|backup [--device-index N]'); return 2;
      } finally { await adapter.disconnect(); }
    }
    const device = new SimulatedDevice();
    if (action === 'discover') { json(output, await device.discover()); return 0; }
    if (action === 'info' || action === 'connect') { await device.connect(); json(output, await device.info()); return 0; }
    if (action === 'inventory') {
      const catalog = await loadAppCatalog(join(workspace, 'BangleApps'));
      const files = await device.inventory();
      json(output, { complete: false, source: 'process-local simulator', files: files.map(file => { const application = associateApplication(file.name, catalog); return { ...file, application, ...classifyDeviceFile({ ...file, application }) }; }), note: 'Metadata-first result; unknown and protected content is not read.' }); return 0;
    }
    if (action === 'backup') {
      const forceFull = has('--full'), c = await config(cwd); let destination;
      try { destination = outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), workspace); } catch (error) { output.error(error.message); return 2; }
      try { const result = await createManagedBackup(device, destination, { forceFull }); json(output, result); return result.manifest.complete ? 0 : 1; }
      catch (error) { output.error(error.message); return 2; }
    }
    output.error('Usage: device inventory|backup --simulate [--mode full|differential]'); return 2;
  }
  if (command === 'backup' && opts[0] === 'list') {
    const c = await config(cwd), root = resolve(val('--directory') || c.backup?.directory || backupDirectory()), records = [];
    for (const name of await readdir(root).catch(() => [])) { try { const path = join(root, name), m = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); records.push({ directory: path, createdAt: m.createdAt, mode: m.mode ?? (m.kind === 'banglesync-device-import' ? 'comparison-diff' : 'logical'), complete: m.complete === true || m.snapshotComplete === true, kind: m.kind }); } catch {} }
    json(output, records); return 0;
  }
  if (command === 'verify') { if (!val('--path')) { output.error('Usage: verify --path <backup-directory>'); return 2; } const target = resolve(cwd, val('--path')), m = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')); const r = m.kind === 'banglesync-managed-backup' ? await verifyManagedBackup(target, { baselineRoot: val('--baseline-root') ? resolve(cwd, val('--baseline-root')) : undefined, outputDirectory: val('--reconstruct') ? resolve(cwd, val('--reconstruct')) : undefined }) : await verifyBackup(target); json(output, r); return r.complete ? 0 : 1; }
  if (command === 'sync') {
    if (!has('--dry-run') && !has('--apply')) { output.error('Use sync --dry-run to preview, or sync --apply with a reviewed plan hash and explicit confirmation.'); return 2; }
    const workspace = val('--path') || await findWorkspace(cwd), desiredPath = join(workspace, 'manifests', 'desired.json');
    let desired; try { desired = JSON.parse(await readFile(desiredPath, 'utf8')); } catch (error) { output.error(error.code === 'ENOENT' ? `No desired-state manifest found at ${desiredPath}. Create it with profile apply or define a files array. No device was contacted.` : `Cannot read desired-state manifest: ${error.message}`); return 2; }
    let stagedSettings = desired.settings ?? {};
    try { const stored = JSON.parse(await readFile(join(workspace, 'manifests', 'device-settings.json'), 'utf8')); stagedSettings = { ...stagedSettings, ...(stored.values ?? {}) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (has('--apply') && Object.keys(stagedSettings).length) { output.error('Device settings are staged but safe per-key device merging is not implemented. No sync actions were applied.'); return 2; }
    const simulated = has('--simulate');
    if (has('--apply') && (simulated || !has('--confirm') || !val('--plan-hash'))) { output.error('Physical apply requires --device-index, --confirm, and --plan-hash from a fresh sync --dry-run. Simulator apply is not persistent.'); return 2; }
    if (!simulated && !val('--device-index')) { output.error('Use --device-index N to select a physical device, or --simulate for a host-only preview. No device was contacted.'); return 2; }
    let device = new SimulatedDevice(), adapter = null, ownership = desired.ownership || {}, selectedDeviceId = null, allowedTargets = null;
    if (!simulated) {
      const catalog = await deviceCatalog(workspace), c = await config(workspace); ownership = catalog.manifest.ownership; allowedTargets = catalog.knownFiles;
      adapter = new EspruinoCliAdapter({ executable: c.transport?.espruinoPath || null, ownership, applications: catalog.applications, baselinePaths: catalog.baselinePaths, knownFiles: catalog.knownFiles, inlineFiles: catalog.inlineFiles });
      const devices = await adapter.discover(), index = Number(val('--device-index')) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= devices.length) { output.error(`Select a discovered device with --device-index 1..${devices.length}.`); return 2; }
      selectedDeviceId = devices[index].id; device = adapter;
    }
    try {
      if (adapter) await adapter.connect(selectedDeviceId);
      const plan = await planSync({ workspaceRoot: workspace, device, desiredFiles: desired.files, ownership, backupVerified: false, allowedTargets });
      const planHashValue = syncPlanHash(plan);
      json(output, { plan, settingsPending: stagedSettings, settingsApplied: false, planHash: planHashValue, reviewedActions: plan.plan.map(item => ({ action: item.action, target: item.target, size: item.size, sha256: item.sha256 })), note: simulated ? 'Process-local simulator preview only.' : 'Physical read-only inventory; transport is not hardware-qualified.' });
      if (!plan.applicable) return 1;
      if (!has('--apply')) return 0;
      if (val('--plan-hash') !== planHashValue) { output.error('Plan hash differs from the reviewed preview. No device files were written; run sync --dry-run again.'); return 2; }
      const c = await config(workspace), hasUpdates = plan.plan.some(item => item.action === 'update');
      let backupDirectoryPath = null, backupCheck = null;
      if (val('--backup')) {
        backupDirectoryPath = outsideWorkspace(resolve(cwd, val('--backup')), workspace);
        backupCheck = await verifyManagedBackup(backupDirectoryPath);
      } else if (hasUpdates) {
        const destination = outsideWorkspace(c.backup?.directory || backupDirectory(), workspace);
        const backup = await createManagedBackup(device, destination, { mode: 'full', ownership });
        backupDirectoryPath = backup.dir; backupCheck = await verifyManagedBackup(backup.dir);
      }
      if (hasUpdates && (!backupCheck?.complete || backupCheck.mode !== 'full')) { output.error('Updating owned files requires a complete verified full backup. No device files were written.'); return 2; }
      if (hasUpdates) {
        const backupManifest = JSON.parse(await readFile(join(backupDirectoryPath, 'manifest.json'), 'utf8'));
        for (const item of plan.plan.filter(entry => entry.action === 'update')) {
          const previous = backupManifest.files.find(file => file.name === item.target && file.status === 'captured');
          if (!previous || previous.sha256 !== item.previousSha256) { output.error(`Backup does not contain the reviewed pre-change bytes for ${item.target}; no device files were written.`); return 2; }
        }
      }
      const applied = await applySyncPlan(device, plan, { confirm: true, backupVerified: Boolean(backupCheck?.complete), ownership, approvedPlanHash: planHashValue });
      json(output, { applied, backup: backupDirectoryPath ? { directory: backupDirectoryPath, complete: backupCheck.complete } : null, backupWarning: backupCheck?.complete ? null : 'Plan contains only new files; no pre-change backup was needed, and no existing target will be overwritten.', note: 'Uploads were read back and verified where supported; partial application is possible.' });
      return applied.complete ? 0 : 1;
    } finally { if (adapter) await adapter.disconnect(); }
  }
  if (['push', 'deploy'].includes(command)) { output.error('Deployment execution is disabled. No watch was contacted or changed.'); return 2; }
  if (!['devices','connect','disconnect','info','inventory','backup','pull','status','diff'].includes(command)) { output.error(`Unknown command: ${command}\nRun bangle-sync --help for usage.`); return 2; }
  if (command === 'backup' && has('--show-destination')) {
    const c = await config(cwd);
    try { output.log(outsideWorkspace(val('--destination') || c.backup?.directory || backupDirectory(), await findWorkspace(cwd))); return 0; }
    catch (error) { output.error(error.message); return 2; }
  }
  if (!has('--simulate')) { output.error(`${command} is not available for real hardware: no verified device transport is enabled. Use --simulate. No watch was contacted.`); return 2; }
  const dev = new SimulatedDevice(), c = await config(cwd);
  if (command === 'devices') { json(output, await dev.discover()); return 0; }
  if (['connect','info','inventory','backup','pull','diff'].includes(command)) await dev.connect();
  if (command === 'connect') { json(output, await dev.info()); return 0; }
  if (command === 'disconnect') { output.log('Disconnected (simulated state is process-local).'); return 0; }
  if (command === 'info') { json(output, await dev.info()); return 0; }
  if (command === 'inventory') { const files = await dev.inventory(); json(output, { complete: false, source: 'simulated', files: files.map(file => ({ ...file, ...classifyDeviceFile(file.name) })), note: 'Unknown files are metadata-only and are not eligible for modification.' }); return 0; }
  if (command === 'backup') {
    let destination;
    try { destination = outsideWorkspace(val('--destination') || val('--out') || c.backup?.directory || backupDirectory(), await findWorkspace(cwd)); }
    catch (error) { output.error(error.message); return 2; }
    if (has('--show-destination')) { output.log(destination); return 0; }
    output.log(`Backup destination: ${destination}`);
    const b = await createBackup(dev, destination); const report = await verifyBackup(b.dir);
    const state = report.complete ? 'COMPLETE_AND_VERIFIED' : 'INCOMPLETE';
    json(output, { destination, directory: b.dir, state, manifest: b.manifest, verification: report });
    return report.complete ? 0 : 1;
  }
  if (command === 'pull') { const name = val('--name'); if (!name) { output.error('Usage: pull --name <device-file> --out <local-file>'); return 2; } await writeFile(resolve(cwd, val('--out') || name), await dev.read(name), { flag: 'wx' }); output.log('Pulled simulated file.'); return 0; }
  if (command === 'status') {
    let latest = null;
    const dest = c.backup?.directory || backupDirectory();
    try { for (const name of await readdir(dest)) { const path = join(dest, name); if ((await stat(path)).isDirectory()) { try { const v = await verifyBackup(path); const m = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); if (!latest || m.createdAt > latest.createdAt) latest = { directory: path, createdAt: m.createdAt, state: v.complete ? 'COMPLETE_AND_VERIFIED' : 'INCOMPLETE' }; } catch {} } } } catch {}
    const inventory = await dev.inventory();
    json(output, { connection: 'SIMULATED (not a physical device)', identityVerified: false, firmware: 'simulated', inventory: { source: 'simulated live session', ordinary: inventory.filter(x => !x.storageFile).length, storageFiles: inventory.filter(x => x.storageFile).length }, backupDestination: dest, latestBackup: latest, deploymentEligibility: 'NOT_EVALUATED' }); return 0;
  }
  if (command === 'diff') {
    const path = val('--backup'); if (!path) { output.error('Usage: diff --simulate --backup <backup-directory>'); return 2; }
    const m = JSON.parse(await readFile(join(resolve(cwd, path), 'manifest.json'), 'utf8')), verified = await verifyBackup(resolve(cwd, path));
    const known = new Map(m.files.map(f => [`${Boolean(f.storageFile)}:${f.name}`, f])); const current = await dev.inventory(); const results = [];
    for (const item of current) { const key = `${Boolean(item.storageFile)}:${item.name}`, previous = known.get(key); if (!previous) results.push({ name: item.name, status: 'watch-only' }); else { known.delete(key); try { const bytes = await dev.read(item.name, { storageFile: Boolean(item.storageFile) }); const hash = createHash('sha256').update(bytes).digest('hex'); results.push({ name: item.name, status: hash === previous.sha256 ? 'identical' : 'modified' }); } catch { results.push({ name: item.name, status: 'unverified' }); } } }
    for (const f of known.values()) results.push({ name: f.name, status: verified.complete ? 'backup-only' : 'uncertain-incomplete-backup' });
    json(output, { backup: resolve(cwd, path), backupState: verified.complete ? 'COMPLETE_AND_VERIFIED' : 'INCOMPLETE', files: results }); return 0;
  }
  return 0;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`bangle-sync: ${error.message}`); process.exitCode = 1; });
