import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

const safeRelative = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
export async function loadAppCatalog(repositoryRoot, { direct = false, appIds = null } = {}) {
  const root = resolve(repositoryRoot), appsRoot = direct ? root : join(root, 'apps'), ids = await readdir(appsRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), filter = Array.isArray(appIds) ? new Set(appIds) : null;
  const apps = [], byStorageName = new Map(), baselineByStorageName = new Map();
  for (const id of ids) {
    if (filter && !filter.has(id)) continue;
    try {
      const directory = join(appsRoot, id), metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      if (metadata.id !== id || !Array.isArray(metadata.storage)) continue;
      const files = [];
      for (const item of metadata.storage) {
        if (typeof item?.name !== 'string' || !safeRelative(item.url) || item.name.includes('/') || item.name.includes('\\')) continue;
        const path = resolve(directory, item.url), rel = relative(directory, path);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
        let size = null; try { const info = await stat(path); if (info.isFile()) size = info.size; } catch {}
        const record = { name: item.name, url: item.url, size };
        files.push(record);
        if (!byStorageName.has(item.name)) byStorageName.set(item.name, []);
        byStorageName.get(item.name).push(id);
        if (!baselineByStorageName.has(item.name)) baselineByStorageName.set(item.name, []);
        baselineByStorageName.get(item.name).push({ repositoryPath: `${direct ? '' : 'apps/'}${id}/${item.url}`, appId: id });
      }
      apps.push({ id, name: String(metadata.name ?? id), version: String(metadata.version ?? ''), type: metadata.type ?? (metadata.tags?.includes?.('clock') ? 'clock' : 'application'), dependencies: Array.isArray(metadata.dependencies) ? metadata.dependencies : [], files, source: direct ? 'custom workspace metadata' : 'official BangleApps metadata' });
    } catch {}
  }
  return {
    repository: root,
    apps,
    byStorageName: Object.fromEntries([...byStorageName].map(([name, ids]) => [name, [...new Set(ids)]])),
    baselineByStorageName: Object.fromEntries([...baselineByStorageName].map(([name, refs]) => [name, [...new Map(refs.map(ref => [`${ref.repositoryPath}:${ref.appId}`, ref])).values()]]))
  };
}
export function associateApplication(filename, catalog) {
  const owners = catalog?.byStorageName?.[filename] ?? [];
  return owners.length === 1 ? owners[0] : null;
}
