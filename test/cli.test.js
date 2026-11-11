import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, starterConfig, VERSION } from '../bin/bangle-sync.js';

function capture() {
  const messages = { out: [], err: [] };
  return { messages, output: { log: value => messages.out.push(value), error: value => messages.err.push(value) } };
}

test('starter config has no device-specific identifiers or upload mappings', () => {
  assert.deepEqual(starterConfig(), {
    schemaVersion: 1,
    project: { name: 'my-bangle-project' },
    sources: [],
    devices: {},
    backup: { directory: join(homedir(), 'BangleSync-Device-Backups') }
  });
});

test('help and version are available', async () => {
  const { messages, output } = capture();
  assert.equal(await run(['--help'], '.', output), 0);
  assert.match(messages.out[0], /Usage: bangle-sync/);
  assert.match(messages.out[0], /connect\s+Connect to a simulated device \(--simulate\)/);
  assert.match(messages.out[0], /limited hardware qualification/);
  assert.equal(await run(['--version'], '.', output), 0);
  assert.equal(messages.out[1], VERSION);
});

test('init creates config and never overwrites an existing config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bangle-sync-'));
  try {
    const { output } = capture();
    assert.equal(await run(['init'], cwd, output), 0);
    const path = join(cwd, 'bangle-sync.json');
    const original = await readFile(path, 'utf8');
    assert.equal(await run(['init'], cwd, output), 1);
    assert.equal(await readFile(path, 'utf8'), original);
    await writeFile(path, original);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('existing backup.directory configuration remains respected', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bangle-backup-config-'));
  const configuredDirectory = join(cwd, 'existing-backups');
  try {
    await writeFile(join(cwd, 'bangle-sync.json'), `${JSON.stringify({ ...starterConfig(), backup: { directory: configuredDirectory } })}\n`);
    const { messages, output } = capture();
    assert.equal(await run(['config', 'get', 'backup.directory'], cwd, output), 0);
    assert.equal(messages.out[0], configuredDirectory);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('workspace commands and app creation use nearest configured workspace from nested directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-workspace-'));
  const workspace = join(root, 'Summit Watch'), nested = join(workspace, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  try {
    const { output, messages } = capture();
    assert.equal(await run(['init'], workspace, output), 0);
    assert.equal(await run(['workspace', 'status'], nested, output), 0);
    assert.equal(JSON.parse(messages.out.at(-1)).workspace, workspace);
    assert.equal(await run(['backup', '--simulate', '--destination', join(workspace, 'unsafe')], nested, output), 2);
    assert.match(messages.err.at(-1), /outside the project workspace/);
    assert.equal(await run(['app', 'create', 'summit-clock', '--type', 'clock'], nested, output), 0);
    assert.equal(JSON.parse(messages.out.at(-1)).directory, join(workspace, 'BangleCustom', 'projects', 'summit-clock'));
    await assert.rejects(run(['app', 'create', 'summit-clock', '--type', 'clock'], nested, output), /refusing to overwrite/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('device update preserves explicit preview/apply gates and delegates to desired-state sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-update-alias-'));
  try {
    const { messages, output } = capture();
    assert.equal(await run(['device', 'update'], root, output), 2);
    assert.match(messages.err.join('\n'), /device update --dry-run/);
    messages.err.length = 0;
    assert.equal(await run(['device', 'update', '--dry-run'], root, output), 2);
    assert.match(messages.err.join('\n'), /No desired-state manifest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unavailable device commands fail clearly without contacting hardware', async () => {
  const { messages, output } = capture();
  assert.equal(await run(['backup'], '.', output), 2);
  assert.match(messages.err[0], /not available/);
});

test('backup directory config and simulator backup verify without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-cli-'));
  const cwd = join(root, 'project'), destination = join(root, 'backups');
  await mkdir(cwd);
  try {
    const { output, messages } = capture();
    assert.equal(await run(['config', 'set', 'backup.directory', destination], cwd, output), 0);
    assert.equal(JSON.parse(await readFile(join(cwd, 'bangle-sync.json'), 'utf8')).backup.directory, destination);
    assert.equal(await run(['backup', '--show-destination'], cwd, output), 0);
    assert.equal(messages.out.at(-1), destination);
    assert.equal(await run(['backup', '--simulate'], cwd, output), 0);
    const result = JSON.parse(messages.out.at(-1));
    assert.equal(result.state, 'COMPLETE_AND_VERIFIED');
    assert.equal(result.verification.complete, true);
    assert.equal(await run(['backup', '--simulate', '--destination', cwd], cwd, output), 2);
    assert.match(messages.err.at(-1), /outside the project workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
