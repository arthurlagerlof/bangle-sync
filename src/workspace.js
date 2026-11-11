import { deflateSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
function safeProjectFile(root, name) {
  if (typeof name !== 'string' || isAbsolute(name)) throw new Error('Invalid project file path');
  const path = resolve(root, name), rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Invalid project file path');
  return path;
}
export const DEFAULT_WORKSPACE = 'C:\\Users\\arthu\\Projects\\BangleWorkspace';
export const validAppId = id => /^[a-z0-9][a-z0-9_-]{0,19}$/.test(id) && !id.endsWith('_');
function iconPlaceholder() {
  const crc = data => { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([t, data])), data.length + 8); return out; };
  const raw = Buffer.alloc(48 * (1 + 48 * 4));
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) { const i = y * 193 + 1 + x * 4, inside = (x - 24) ** 2 + (y - 24) ** 2 < 17 ** 2; raw[i] = inside ? 35 : 220; raw[i + 1] = inside ? 80 : 220; raw[i + 2] = inside ? 115 : 220; raw[i + 3] = 255; }
  const header = Buffer.alloc(13); header.writeUInt32BE(48, 0); header.writeUInt32BE(48, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function createApp(workspace, id, type = 'standard') {
  if (!validAppId(id)) throw new Error('App ID must be lowercase letters, digits, _ or -, start with a letter/digit, and be at most 20 characters (Storage filenames are limited to 28).');
  if (!['standard', 'clock', 'widget'].includes(type)) throw new Error('App type must be standard, clock, or widget.');
  const dir = resolve(workspace, 'BangleCustom', 'projects', id);
  await mkdir(resolve(workspace, 'BangleCustom', 'projects'), { recursive: true });
  try { await mkdir(dir, { recursive: false }); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Project '${id}' already exists; refusing to overwrite it.`); throw error; }
  const name = id.split(/[-_]/).filter(Boolean).map(x => x[0].toUpperCase() + x.slice(1)).join(' ') || id;
  const storageName = `${id}.${type === 'widget' ? 'wid' : 'app'}.js`;
  const code = type === 'widget'
    ? '(() => {\n  WIDGETS["' + id + '"] = { area: "tl", width: 24, draw: function() {\n    g.reset();\n    g.drawString("' + name.slice(0, 2) + '", this.x, this.y);\n  } };\n})();\n'
    : type === 'clock'
      ? 'Bangle.setUI("clock");\nBangle.loadWidgets();\nfunction draw() {\n  var d = new Date();\n  var time = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);\n  g.reset().clear();\n  g.setFont("Vector", 32).setFontAlign(0, 0);\n  g.drawString(time, g.getWidth() / 2, g.getHeight() / 2);\n}\nsetInterval(draw, 10000);\ndraw();\n'
      : 'g.clear();\nE.showMessage("' + name + '", "' + name + '");\n';
  const metadata = { id, name, shortName: name.slice(0, 16), version: '0.01', author: 'local', description: `A custom ${type} application for Bangle.js 2.`, icon: 'app.png', ...(type !== 'standard' ? { type } : {}), tags: type === 'widget' ? 'widget' : type === 'clock' ? 'clock' : '', supports: ['BANGLEJS2'], allow_emulator: true, readme: 'README.md', storage: [{ name: storageName, url: type === 'widget' ? 'widget.js' : 'app.js' }] };
  await writeFile(join(dir, 'app.js'), type === 'widget' ? '// Widget source is widget.js for BangleApps compatibility.\n' : code, { flag: 'wx' });
  if (type === 'widget') await writeFile(join(dir, 'widget.js'), code, { flag: 'wx' });
  await writeFile(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(dir, 'README.md'), `# ${name}\n\nCustom Bangle.js 2 ${type} application.\n\n- Storage entry: \`${storageName}\`\n- App Loader: copy/import this project into a local BangleApps development checkout only when intentionally testing it.\n- Physical deployment is not performed by this generator.\n`, { flag: 'wx' });
  await writeFile(join(dir, 'app.png'), iconPlaceholder(), { flag: 'wx' });
  return { id, type, directory: dir, storageName, metadata };
}

export async function workspaceStatus(workspace) {
  const repos = {};
  for (const [name, path] of [['BangleApps', join(workspace, 'BangleApps')], ['BangleCustom', join(workspace, 'BangleCustom')]]) {
    try { const { stdout } = await exec('git', ['-C', path, 'status', '--short', '--branch']); repos[name] = { path, git: stdout.trim() }; }
    catch { repos[name] = { path, exists: false }; }
  }
  return { workspace, repos, imports: await readdir(join(workspace, 'BangleCustom', 'device-imports')).catch(() => []), note: 'Device snapshots are read-only imports; the emulator filesystem is not claimed accessible.' };
}

export async function workspaceDiff(workspace) {
  const upstream = join(workspace, 'BangleApps', 'apps');
  const custom = join(workspace, 'BangleCustom', 'projects');
  const projects = [];
  for (const id of await readdir(custom).catch(() => [])) {
    const customPath = join(custom, id);
    try {
      const localMeta = JSON.parse(await readFile(join(customPath, 'metadata.json'), 'utf8'));
      const upstreamPath = join(upstream, id);
      let upstreamMeta;
      try { upstreamMeta = JSON.parse(await readFile(join(upstreamPath, 'metadata.json'), 'utf8')); } catch {}
      const files = [];
      const localEntries = localMeta.storage || [], upstreamEntries = upstreamMeta?.storage || [];
      const upstreamByName = new Map(upstreamEntries.map(entry => [entry.name, entry]));
      const localByName = new Map(localEntries.map(entry => [entry.name, entry]));
      for (const entry of localEntries) {
        const other = upstreamByName.get(entry.name);
        if (!other) { files.push({ name: entry.name, status: 'new' }); continue; }
        try {
          const [left, right] = await Promise.all([readFile(safeProjectFile(customPath, entry.url)), readFile(safeProjectFile(upstreamPath, other.url))]);
          files.push({ name: entry.name, status: left.equals(right) ? 'identical' : 'modified' });
        } catch { files.push({ name: entry.name, status: 'cannot-compare' }); }
      }
      for (const entry of upstreamEntries) if (!localByName.has(entry.name)) files.push({ name: entry.name, status: 'deleted-from-custom' });
      const knownLocalFiles = new Set(['metadata.json', 'README.md', 'app.png', 'icon.png', 'app.js', 'widget.js', ...localEntries.map(entry => entry.url)]);
      const unknown = (await readdir(customPath, { withFileTypes: true })).filter(entry => entry.isFile() && !knownLocalFiles.has(entry.name)).map(entry => entry.name);
      for (const name of unknown) files.push({ name, status: 'unknown' });
      projects.push({ id, status: upstreamMeta ? 'compared' : 'custom-only', files, potentiallyProtected: localEntries.some(x => /^(boot|setting|setting\.json)/i.test(x.name)) });
    } catch { projects.push({ id, status: 'unknown-or-invalid-custom-project', files: [] }); }
  }
  return { compared: ['official BangleApps storage assets', 'BangleCustom/projects'], projects, deviceImports: 'not compared without explicit imported snapshot manifest', emulator: 'not compared; emulator filesystem access is not established' };
}

export async function updateUpstream(workspace) {
  const repo = join(workspace, 'BangleApps');
  const { stdout: status } = await exec('git', ['-C', repo, 'status', '--porcelain']);
  if (status.trim()) throw new Error('BangleApps has local changes; refusing upstream update. Review or preserve them before updating.');
  const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['-C', repo, 'pull', '--ff-only']);
  const after = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  return { before, after, changed: before !== after, note: 'Custom projects and device imports were not merged.' };
}

