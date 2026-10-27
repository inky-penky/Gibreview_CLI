import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type RunState } from '../state.js';
import { createClient } from '../gibwork.js';
import { collectRun, planRun, planTriage, publishRun } from '../engine.js';
import { confirmCode, guardSpend, parseMaxBudget, paySpend, publishSpend, SpendRefused, type GuardConfig } from '../spendguard.js';

const examplePlan = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'checkout-regression.yaml');
const open: GuardConfig = { allowProduction: false };

async function freshRun(environment: RunState['environment'] = 'mock') {
  const dir = await mkdtemp(join(tmpdir(), 'gibreview-guard-'));
  const store = new Store(join(dir, '.gibreview/qa'));
  const { run } = await planRun(examplePlan, store, environment);
  return { run, store };
}

const refused = (fn: () => void, match: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SpendRefused && match.test(e.message));

test('publish is refused without a code, and the refusal carries the cost and the code', async () => {
  const { run } = await freshRun();
  const spend = publishSpend(run);
  const code = confirmCode(run, spend);
  assert.match(code, /^publish-\d+\.\d{2}-USDC-[0-9a-f]{6}$/);
  refused(() => guardSpend(run, spend, undefined, open), new RegExp(`${spend.cents / 100}.*confirmCode="${code}"`));
  assert.doesNotThrow(() => guardSpend(run, spend, code, open));
});

test('a code approved for one amount does not cover another', async () => {
  const { run } = await freshRun();
  const allCode = confirmCode(run, publishSpend(run));
  const oneBatch = publishSpend(run, run.batches[0].id);
  refused(() => guardSpend(run, oneBatch, allCode, open), /stale or wrong/);
  refused(() => guardSpend(run, publishSpend(run), 'publish-0.01-USDC-000000', open), /stale or wrong/);

  // Same plan in a different run gets a different code.
  const other = await freshRun();
  assert.notEqual(confirmCode(other.run, publishSpend(other.run)), allCode);
});

test('production needs the operator flag even with a valid code', async () => {
  const { run } = await freshRun('production');
  const spend = publishSpend(run);
  const code = confirmCode(run, spend);
  refused(() => guardSpend(run, spend, code, open), /GIBREVIEW_MCP_ALLOW_PRODUCTION/);
  assert.doesNotThrow(() => guardSpend(run, spend, code, { allowProduction: true }));
});

test('budget cap blocks over-budget publishing whatever the agent passes', async () => {
  const { run, store } = await freshRun();
  const spend = publishSpend(run);
  const code = confirmCode(run, spend);
  const total = (spend.cents / 100).toFixed(2);
  refused(() => guardSpend(run, spend, code, { allowProduction: false, maxBudget: '1.00' }), /over the operator's cap of 1\.00/);
  assert.doesNotThrow(() => guardSpend(run, spend, code, { allowProduction: false, maxBudget: total }));

  // The cap counts escrow already funded: after publishing one batch, the rest must still fit.
  const client = createClient({ environment: 'mock', stateDir: store.dir });
  await publishRun(run, client, store, { batchId: run.batches[0].id });
  const rest = publishSpend(run);
  const onePool = spend.cents / run.batches.length / 100;
  refused(() => guardSpend(run, rest, confirmCode(run, rest), { allowProduction: false, maxBudget: onePool.toFixed(2) }), /over the operator's cap/);
});

test('an unreadable cap fails closed', () => {
  assert.equal(parseMaxBudget(undefined), null);
  assert.equal(parseMaxBudget('50'), 5000);
  assert.throws(() => parseMaxBudget('fifty'), SpendRefused);
});

test('payout code is tied to the exact triage decisions', async () => {
  const { run, store } = await freshRun();
  const client = createClient({ environment: 'mock', stateDir: store.dir });
  await publishRun(run, client, store);
  await collectRun(run, client, store);

  const actions = planTriage(run);
  const spend = paySpend(actions);
  const approvals = actions.filter((a) => a.action === 'approve').length;
  assert.equal(spend.cents, approvals * 200);
  const code = confirmCode(run, spend);
  assert.match(code, /^pay-/);
  refused(() => guardSpend(run, spend, undefined, open), /pay .* USDC to testers/);
  assert.doesNotThrow(() => guardSpend(run, spend, code, open));

  // Dropping one decision (e.g. new state since the preview) invalidates the code.
  refused(() => guardSpend(run, paySpend(actions.slice(1)), code, open), /stale or wrong/);
});

test('nothing to spend needs no code', async () => {
  const { run } = await freshRun();
  run.batches.forEach((b) => (b.taskId = 'already'));
  assert.doesNotThrow(() => guardSpend(run, publishSpend(run), undefined, open));
});
