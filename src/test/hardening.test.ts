import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../state.js';
import { createClient } from '../gibwork.js';
import { collectRun, mapReviewStatus, planRun, planTriage, publishRun } from '../engine.js';
import { aggregate } from '../aggregate.js';

const examplePlan = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'checkout-regression.yaml');

async function collectedRun() {
  const dir = await mkdtemp(join(tmpdir(), 'bugbash-hard-'));
  const store = new Store(join(dir, '.bugbash'));
  const { run } = await planRun(examplePlan, store, 'mock');
  const client = createClient({ environment: 'mock', stateDir: store.dir });
  await publishRun(run, client, store);
  await collectRun(run, client, store);
  return { run, store };
}

test('Gibwork statuses map to review states, and unknown ones are never guessed', () => {
  assert.equal(mapReviewStatus('OPEN'), 'pending');
  assert.equal(mapReviewStatus('REJECTED'), 'rejected');
  for (const s of ['CLAIMED', 'CLAIMING', 'WAITING_CLAIM', 'PROCESSING']) assert.equal(mapReviewStatus(s), 'approved');
  assert.equal(mapReviewStatus('CLOSED'), 'other');
  assert.equal(mapReviewStatus('SOMETHING_NEW'), 'other');
});

test('an unrecognised status holds a slot and is never paid or rejected automatically', async () => {
  const { run } = await collectedRun();
  const batch = run.batches[0];
  const subs = Object.values(run.submissions).filter((s) => s.batchId === batch.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const odd = subs.find((s) => s.parsed.verdict === 'valid')!;
  odd.reviewStatus = 'other';
  odd.remoteStatus = 'CLOSED';

  const actions = planTriage(run).filter((a) => a.batchId === batch.id);
  const forOdd = actions.filter((a) => a.submissionId === odd.id);
  assert.deepEqual(forOdd.map((a) => a.action), ['hold']);
  assert.match(forOdd[0].reason, /CLOSED/);
  assert.equal(actions.filter((a) => a.action === 'approve').length, run.plan.reward.testersPerBatch - 1, 'the unclear one uses up a paid slot');
  assert.equal(aggregate(run).totals.needsAttention, 1);
});

test('incomplete work awaiting triage never moves the release gate', async () => {
  const { run } = await collectedRun();
  // Leave only the incomplete submission on the first bounty: it reports TC-02 as FAIL with no evidence.
  const first = run.batches[0];
  for (const s of Object.values(run.submissions)) {
    if (s.batchId === first.id && s.parsed.verdict !== 'incomplete') s.reviewStatus = 'rejected';
  }
  const incomplete = Object.values(run.submissions).find((s) => s.batchId === first.id && s.parsed.verdict === 'incomplete')!;
  assert.ok(incomplete.parsed.results.some((r) => r.caseId === 'TC-02' && r.status === 'FAIL'));

  const agg = aggregate(run);
  const cell = agg.cases.find((c) => c.testCase.id === 'TC-02')!.cells.find((c) => c.deviceId === first.deviceId)!;
  assert.equal(cell.outcome, 'NOT_RUN', 'an unevidenced FAIL awaiting triage is not counted');
  assert.ok(agg.totals.awaitingTriage >= 1);
  assert.notEqual(agg.gate.verdict, 'FAIL');
});

test('a run can only be changed by one process at a time', async () => {
  const { run, store } = await collectedRun();
  let release!: () => void;
  const holding = store.withRun(run.runId, () => new Promise<void>((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(store.withRun(run.runId, async () => 'second'), /is busy/);
  release();
  await holding;
  assert.equal(await store.withRun(run.runId, async () => 'after'), 'after', 'lock is released when the first finishes');
  assert.equal(existsSync(join(store.dir, 'runs', `${run.runId}.lock`)), false);
});

test('a lock left by a crashed process is cleared', async () => {
  const { run, store } = await collectedRun();
  const dead = spawnSync(process.execPath, ['-e', '']).pid!; // has exited by the time spawnSync returns
  await writeFile(join(store.dir, 'runs', `${run.runId}.lock`), JSON.stringify({ pid: dead, at: '2026-01-01T00:00:00.000Z' }));
  assert.equal(await store.withRun(run.runId, async (r) => r.runId), run.runId);
});

test('the lock hands each holder a fresh copy of the run', async () => {
  const { run, store } = await collectedRun();
  await store.withRun(run.runId, async (r) => {
    r.batches[0].refundedAt = 'marked';
    await store.save(r);
  });
  await store.withRun(run.runId, async (r) => assert.equal(r.batches[0].refundedAt, 'marked'));
});

test('.env.local is loaded and wins over .env, but never over the real environment', async () => {
  const { loadEnvFiles } = await import('../gibwork.js');
  const dir = await mkdtemp(join(tmpdir(), 'bugbash-env-'));
  await writeFile(join(dir, '.env'), 'BB_T_SHARED=from-env\nBB_T_ENV_ONLY=env\nBB_T_PRESET=from-env\n');
  await writeFile(join(dir, '.env.local'), 'BB_T_SHARED=from-local\nBB_T_PRESET=from-local\n');
  process.env.BB_T_PRESET = 'from-shell';
  try {
    assert.equal(loadEnvFiles(dir).length, 2);
    assert.equal(process.env.BB_T_SHARED, 'from-local');
    assert.equal(process.env.BB_T_ENV_ONLY, 'env');
    assert.equal(process.env.BB_T_PRESET, 'from-shell');
  } finally {
    for (const k of ['BB_T_SHARED', 'BB_T_ENV_ONLY', 'BB_T_PRESET']) delete process.env[k];
  }
});
