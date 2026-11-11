import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, validAppId, workspaceDiff, workspaceStatus, updateUpstream } from '../src/workspace.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'banglesync-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'BangleCustom', 'projects'), { recursive: true });
  await mkdir(join(root, 'BangleCustom', 'device-imports'), { recursive: true });
  await mkdir(join(root, 'BangleApps', 'apps'), { recursive: true });
  return root;
}

test('application scaffolding emits official metadata and type-specific Storage filenames', async t => {
  const root = await fixture(t);
  const app = await createApp(root, 'my-clock', 'clock');
  const metadata = JSON.parse(await readFile(join(app.directory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.id, 'my-clock');
  assert.equal(metadata.type, 'clock');
  assert.equal(metadata.allow_emulator, true);
  assert.equal(metadata.storage[0].name, 'my-clock.app.js');
  assert.ok(metadata.storage[0].name.length <= 28);
  assert.equal((await readFile(join(app.directory, 'app.js'), 'utf8')).includes('Bangle.setUI'), true);
  const icon = await readFile(join(app.directory, 'app.png'));
  assert.equal(icon.readUInt32BE(16), 48);
  assert.equal(icon.readUInt32BE(20), 48);
});

test('widget scaffolding uses widget metadata and storage convention', async t => {
  const root = await fixture(t);
  const app = await createApp(root, 'my-widget', 'widget');
  const metadata = JSON.parse(await readFile(join(app.directory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.type, 'widget');
  assert.equal(metadata.storage[0].name, 'my-widget.wid.js');
  assert.match(await readFile(join(app.directory, 'widget.js'), 'utf8'), /WIDGETS/);
});

test('application IDs and types are checked before creating files', async t => {
  const root = await fixture(t);
  assert.equal(validAppId('abcdefghijklmnopqrst'), true);
  assert.equal(validAppId('abcdefghijklmnopqrstu'), false);
  await assert.rejects(createApp(root, 'BadName'), /App ID/);
  await assert.rejects(createApp(root, 'valid-name', 'unsupported'), /App type/);
});

test('workspace comparison isolates device imports from upstream and custom projects', async t => {
  const root = await fixture(t);
  const upstreamApp = join(root, 'BangleApps', 'apps', 'my-app');
  const customApp = join(root, 'BangleCustom', 'projects', 'my-app');
  await mkdir(upstreamApp);
  await mkdir(customApp);
  await writeFile(join(upstreamApp, 'upstream.js'), 'old');
  await writeFile(join(upstreamApp, 'removed.js'), 'removed');
  await writeFile(join(customApp, 'app.js'), 'changed');
  await writeFile(join(customApp, 'new.js'), 'new');
  await writeFile(join(customApp, 'unexpected.bin'), 'unknown');
  await writeFile(join(upstreamApp, 'metadata.json'), JSON.stringify({ storage: [{ name: 'my-app.app.js', url: 'upstream.js' }, { name: 'removed.app.js', url: 'removed.js' }] }));
  await writeFile(join(customApp, 'metadata.json'), JSON.stringify({ storage: [{ name: 'my-app.app.js', url: 'app.js' }, { name: 'new.app.js', url: 'new.js' }] }));
  await writeFile(join(root, 'BangleCustom', 'device-imports', 'capture.json'), '{}');
  const diff = await workspaceDiff(root);
  const statuses = Object.fromEntries(diff.projects[0].files.map(file => [file.name, file.status]));
  assert.equal(statuses['my-app.app.js'], 'modified');
  assert.equal(statuses['new.app.js'], 'new');
  assert.equal(statuses['removed.app.js'], 'deleted-from-custom');
  assert.equal(statuses['unexpected.bin'], 'unknown');
  assert.match(diff.emulator, /not compared/);
  assert.match(diff.deviceImports, /not compared/);
  assert.deepEqual((await workspaceStatus(root)).imports, ['capture.json']);
});

test('upstream updates refuse dirty upstream state and never merge custom files', async t => {
  const root = await fixture(t);
  const repo = join(root, 'BangleApps');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'local.txt'), 'uncommitted');
  await assert.rejects(updateUpstream(root), /local changes/);
  assert.equal(await readFile(join(repo, 'local.txt'), 'utf8'), 'uncommitted');
});
