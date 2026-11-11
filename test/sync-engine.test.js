import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySyncPlan, planSync, syncPlanHash } from '../src/sync-engine.js';

async function prepare(root) {
  const source = join(root, 'app.js');
  await mkdir(root, { recursive: true });
  await writeFile(source, Buffer.from('verified app contents'));
  const deviceFiles = new Map();
  const device = {
    inventory: async () => [...deviceFiles.keys()].map(name => ({ name, storageFile: false })),
    read: async name => deviceFiles.get(name),
    write: async (name, data, { onState }) => {
      for (const state of ['staging', 'staged', 'verified', 'committing']) onState(state);
      deviceFiles.set(name, Buffer.from(data));
      onState('committed');
    }
  };
  const plan = await planSync({
    workspaceRoot: root,
    device,
    desiredFiles: [{ source: 'app.js', target: 'sync-test.app.js', owner: 'app:sync-test' }]
  });
  return { device, plan };
}

test('sync result distinguishes verified and committed states from upload progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-sync-state-'));
  try {
    const { device, plan } = await prepare(root);
    const result = await applySyncPlan(device, plan, {
      confirm: true,
      approvedPlanHash: syncPlanHash(plan)
    });
    assert.equal(result.complete, true);
    assert.equal(result.results[0].status, 'committed');
    assert.deepEqual(result.results[0].states, ['pending', 'staging', 'staged', 'verified', 'committing', 'committed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('sync reports interrupted writes as partially-written, not committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bangle-sync-partial-'));
  try {
    const { device, plan } = await prepare(root);
    device.write = async (_name, _data, { onState }) => {
      onState('staging');
      const error = new Error('simulated transfer interruption');
      error.transferState = 'partially-written';
      error.recoveryRequired = true;
      throw error;
    };
    const result = await applySyncPlan(device, plan, {
      confirm: true,
      approvedPlanHash: syncPlanHash(plan)
    });
    assert.equal(result.complete, false);
    assert.equal(result.results[0].status, 'partially-written');
    assert.equal(result.results[0].recoveryRequired, true);
    assert.equal(result.results[0].states.at(-1), 'partially-written');
  } finally { await rm(root, { recursive: true, force: true }); }
});
