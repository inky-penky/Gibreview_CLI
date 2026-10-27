import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBatches, fromCents, toCents, validatePlan, PlanError } from '../plan.js';
import { Store } from '../state.js';
import { createClient } from '../gibwork.js';
import { collectRun, gateExitCode, planRun, planTriage, applyTriage, publishRun, reportRun } from '../engine.js';

const examplePlan = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'checkout-regression.yaml');

test('money helpers avoid float drift', () => {
  assert.equal(toCents('2.5'), 250);
  assert.equal(toCents('0.10'), 10);
  assert.equal(fromCents(toCents('0.10') * 3), '0.30');
});

test('batches respect batchSize and per-case device filters', () => {
  const plan = validatePlan({
    name: 'Mini',
    build: { url: 'https://example.com' },
    reward: { perTester: '1' },
    batchSize: 2,
    devices: [{ id: 'a', label: 'Device A' }, { id: 'b', label: 'Device B' }],
    cases: [
      { id: 'C1', title: 'one', steps: ['x'], expected: 'ok!' },
      { id: 'C2', title: 'two', steps: ['x'], expected: 'ok!' },
      { id: 'C3', title: 'three', steps: ['x'], expected: 'ok!', devices: ['b'] },
    ],
  });
  const b = buildBatches(plan);
  assert.deepEqual(b.map((x) => [x.id, x.caseIds]), [['a-1', ['C1', 'C2']], ['b-1', ['C1', 'C2']], ['b-2', ['C3']]]);
});

test('invalid plans report every issue', () => {
  assert.throws(
    () => validatePlan({ name: 'x', build: { url: 'nope' }, reward: { perTester: '1.234' }, devices: [], cases: [] }),
    (e: unknown) => e instanceof PlanError && e.issues.length >= 4,
  );
});

test('full mock run blocks the release on the reproduced high-priority failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gibreview-test-'));
  const store = new Store(join(dir, '.gibreview/qa'));
  const { run } = await planRun(examplePlan, store, 'mock');
  const client = createClient({ environment: 'mock', stateDir: store.dir });

  const pub = await publishRun(run, client, store);
  assert.equal(pub.published.length, run.batches.length);
  const again = await publishRun(run, client, store);
  assert.equal(again.skipped.length, run.batches.length, 'publish is idempotent');

  const col = await collectRun(run, client, store);
  assert.equal(col.fetched, run.batches.length * 4);

  const actions = planTriage(run);
  const pays = actions.filter((a) => a.action === 'approve');
  assert.equal(pays.length, run.batches.length * run.plan.reward.testersPerBatch, 'never pays more testers than the pool allows');
  await applyTriage(run, client, store, actions);
  assert.equal(planTriage(run).length, 0, 'nothing left to triage');

  const { agg, files } = await reportRun(run, join(dir, 'out'), ['md', 'csv', 'junit', 'json']);
  assert.equal(agg.gate.verdict, 'FAIL');
  assert.equal(gateExitCode(agg), 1);
  assert.equal(agg.cases.find((c) => c.testCase.id === 'TC-02')!.outcome, 'FAIL');
  assert.equal(agg.cases.find((c) => c.testCase.id === 'TC-03')!.outcome, 'DISPUTED');
  assert.equal(agg.totals.paid, '24.00');
  assert.equal(files.length, 4);

  const reloaded = await store.load(run.runId);
  assert.equal(Object.keys(reloaded.submissions).length, col.fetched, 'state persisted to disk');
});
