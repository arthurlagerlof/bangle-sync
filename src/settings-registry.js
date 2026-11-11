import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { initializeManagedWorkspace } from './management.js';

const allowedFiles = new Set(['setting.json', 'wid_settings.json']);
const safeKey = key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
async function readRegistry(root) {
  const path = join(root, 'config', 'registry.json'), value = JSON.parse(await readFile(path, 'utf8'));
  if (value.schemaVersion !== 1 || value.kind !== 'banglesync-settings-registry' || !Array.isArray(value.settings)) throw new Error('Invalid device settings registry.');
  const keys = new Set();
  for (const item of value.settings) {
    if (!allowedFiles.has(item?.file) || !safeKey(item.key) || !['boolean', 'number', 'string'].includes(item.type)) throw new Error('Device settings registry contains an invalid entry.');
    const id = `${item.file}:${item.key}`; if (keys.has(id)) throw new Error('Device settings registry contains a duplicate key.'); keys.add(id);
  }
  return { path, value };
}
export async function registerDeviceSetting(root, file, key, type) {
  if (!allowedFiles.has(file) || !safeKey(key) || !['boolean', 'number', 'string'].includes(type)) throw new Error('Register only simple boolean, number, or string keys in setting.json or wid_settings.json.');
  await initializeManagedWorkspace(root);
  const { path, value } = await readRegistry(root), entry = { file, key, type };
  const existing = value.settings.find(item => item.file === file && item.key === key);
  if (existing && existing.type !== type) throw new Error(`Setting ${file}:${key} is already registered as ${existing.type}.`);
  if (!existing) value.settings.push(entry);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return entry;
}
export async function setDesiredDeviceSetting(root, file, key, rawValue) {
  if (!allowedFiles.has(file) || !safeKey(key)) throw new Error('Invalid registered setting key.');
  await initializeManagedWorkspace(root);
  const { value: registry } = await readRegistry(root), definition = registry.settings.find(item => item.file === file && item.key === key);
  if (!definition) throw new Error(`Setting ${file}:${key} is not allowlisted. Register its exact type first.`);
  let value;
  if (definition.type === 'boolean') {
    if (rawValue !== 'true' && rawValue !== 'false') throw new Error('Boolean setting values must be true or false.');
    value = rawValue === 'true';
  } else if (definition.type === 'number') {
    if (String(rawValue).trim() === '') throw new Error('Number setting value is required.');
    value = Number(rawValue); if (!Number.isFinite(value)) throw new Error('Number setting value must be finite.');
  } else {
    value = String(rawValue); if (value.length > 1024) throw new Error('String setting exceeds 1024 characters.');
  }
  const path = join(root, 'manifests', 'device-settings.json');
  let desired = { schemaVersion: 1, kind: 'banglesync-desired-settings', values: {} };
  try { desired = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (desired.schemaVersion !== 1 || desired.kind !== 'banglesync-desired-settings' || !desired.values || typeof desired.values !== 'object' || Array.isArray(desired.values)) throw new Error('Invalid desired-settings manifest.');
  if (desired.values[file] !== undefined && (!desired.values[file] || typeof desired.values[file] !== 'object' || Array.isArray(desired.values[file]))) throw new Error('Desired setting values must be grouped by file.');
  desired.values[file] = { ...(desired.values[file] || {}), [key]: value };
  await writeFile(path, `${JSON.stringify(desired, null, 2)}\n`);
  return { file, key, value, type: definition.type, appliedToDevice: false };
}
export async function listDeviceSettings(root) {
  let value = { settings: [] };
  try { ({ value } = await readRegistry(root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let desired = { values: {} };
  try { desired = JSON.parse(await readFile(join(root, 'manifests', 'device-settings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { registry: value.settings, desired: desired.values, appliedToDevice: false, note: 'Device changes are not inferred from JSON files; values are staged locally and require a future registered-key sync operation.' };
}
