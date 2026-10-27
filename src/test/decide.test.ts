import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../state.js';
import { createClient, type GibworkLike } from '../gibwork.js';
import { loadBrief, validateBrief } from '../review/brief.js';
import { attachTask, collectReview, publishBrief, type ReviewState } from '../review/engine.js';
import { applyDecisions, closePreview, closeReview, contentHash, decisionCode, planDecisions } from '../review/decide.js';
import { mockFetch } from '../review/mockweb.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'review');

async function collected(brief: string, edit?: (raw: Record<string, unknown>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'gibdecide-'));
  const store = new Store<ReviewState>(join(dir, '.gibreview'));
  const client = createClient({ environment: 'mock', stateDir: store.dir });
  let b = await loadBrief(join(examples, brief));
  if (edit) {
    const raw = structuredClone(b) as Record<string, unknown>;
    edit(raw);
    b = validateBrief(raw);
  }
  const state = await publishBrief(b, brief, 'mock', client, store);
  await collectReview(state, client, store, { fetch: mockFetch });
  return { store, client, state };
}

const byUser = (actions: ReturnType<typeof planDecisions>['actions']) => Object.fromEntries(actions.map((a) => [a.username, a]));

test('multiple-winners: pays by place, asks for fixes, rejects the rest, and the pool remainder is left', async () => {
  const { state } = await collected('content-brief.yaml');
  const plan = planDecisions(state);
  const a = byUser(plan.actions);
  assert.deepEqual([a.ada_writes.action, a.ada_writes.amount, a.ada_writes.message], ['pay', '15.00', '1st place']);
  assert.deepEqual([a['tunde.docs'].action, a['tunde.docs'].amount, a['tunde.docs'].message], ['pay', '10.00', '2nd place']);
  assert.equal(a.kemi_b.action, 'request-changes');
  assert.match(a.kemi_b.message, /returns 404/);
  assert.equal(a.shorty.action, 'request-changes');
  assert.match(a.copycat.message, /^Not accepted: 86% the same as @ada_writes/);
  assert.equal(a.late_lara.action, 'reject');
  assert.match(a.quickcash99.message, /SUBMISSION block/);
  assert.equal(plan.payCents, 2_500);
  assert.ok(plan.notes.some((n) => /1 paid place is still open and 2 submissions are being fixed/.test(n)));
});

test('apply needs nothing twice: payments, comments and rejections are recorded and not repeated', async () => {
  const { store, client, state } = await collected('content-brief.yaml');
  const plan = planDecisions(state);
  await applyDecisions(state, client, store, plan);
  assert.ok(plan.actions.every((x) => x.action === 'hold' || x.outcome === 'done'));

  // A fresh collect keeps the decisions and the fix requests.
  await collectReview(state, client, store, { fetch: mockFetch });
  const ada = Object.values(state.submissions).find((s) => s.username === 'ada_writes')!;
  assert.deepEqual([ada.decision?.action, ada.decision?.place, ada.decision?.amount, ada.reviewStatus], ['pay', 1, '15.00', 'approved']);
  assert.ok(ada.decision?.txHash);

  const again = planDecisions(state);
  assert.deepEqual(again.actions.map((x) => [x.username, x.action]), [['kemi_b', 'hold'], ['shorty', 'hold']]);
  assert.match(again.actions[0].message, /waiting for @kemi_b to fix it/);
  assert.equal(again.paidCents, 2_500);
  assert.equal(decisionCode(state, again), null, 'nothing to confirm');

  // When a participant changes their submission and it now passes, it takes the open 3rd place.
  const kemi = Object.values(state.submissions).find((s) => s.username === 'kemi_b')!;
  kemi.content += ' (fixed)';
  kemi.checks = [];
  kemi.verdict = 'eligible';
  const fixed = byUser(planDecisions(state).actions);
  assert.deepEqual([fixed.kemi_b.action, fixed.kemi_b.amount, fixed.kemi_b.message], ['pay', '5.00', '3rd place']);
});

test('the confirm code covers the exact plan', async () => {
  const { state } = await collected('content-brief.yaml');
  const plan = planDecisions(state);
  const code = decisionCode(state, plan)!;
  assert.match(code, /^pay-25\.00-USDC-[0-9a-f]{6}$/);
  assert.equal(decisionCode(state, planDecisions(state)), code, 'same plan, same code');

  // A changed amount or a new action gives a different code.
  const swapped = { ...plan, actions: plan.actions.map((a) => (a.username === 'tunde.docs' ? { ...a, amount: '15.00' } : a)) };
  assert.notEqual(decisionCode(state, swapped), code);
  const shorter = { ...plan, actions: plan.actions.filter((a) => a.username !== 'copycat') };
  assert.notEqual(decisionCode(state, shorter), code);
});

test('close refunds what nobody won, and refuses while planned winners are unpaid', async () => {
  const { store, client, state } = await collected('content-brief.yaml');
  const before = closePreview(state);
  assert.deepEqual(before.unpaidWinners.map((a) => a.username), ['ada_writes', 'tunde.docs']);
  assert.equal(before.left, '30.00');

  await applyDecisions(state, client, store, planDecisions(state));
  const after = closePreview(state);
  assert.deepEqual([after.paid, after.left, after.unpaidWinners.length, after.undecided], ['25.00', '5.00', 0, 2]);

  const closed = await closeReview(state, client, store);
  assert.equal(closed.refunded, '5.00');
  await assert.rejects(closeReview(state, client, store), /already closed/);
  assert.deepEqual(planDecisions(state).actions, []);
});

test('pool: every accepted submission earns the same amount, as many as the attached pool covers', async () => {
  const { store, client, state: published } = await collected('content-brief.yaml', (raw) => {
    raw.payout = { rule: 'pool', amounts: ['12.00'] };
  });
  // Attach reads the pool from Gibwork (30.00), which covers two payments of 12.00.
  const state = await attachTask(published.task.id!, published.brief, 'content-brief.yaml', 'mock', client, store);
  await collectReview(state, client, store, { fetch: mockFetch });
  const pays = planDecisions(state).actions.filter((a) => a.action === 'pay');
  assert.deepEqual(pays.map((a) => [a.username, a.amount, a.message]), [['ada_writes', '12.00', 'accepted'], ['tunde.docs', '12.00', 'accepted']]);
});

test('one-winner pays only the best; nobody is asked to fix work that could no longer win', async () => {
  const { state } = await collected('content-brief.yaml', (raw) => {
    raw.payout = { rule: 'one-winner', amounts: ['30.00'] };
  });
  const a = byUser(planDecisions(state).actions);
  assert.deepEqual([a.ada_writes.action, a.ada_writes.amount, a.ada_writes.message], ['pay', '30.00', 'winner']);
  assert.equal(a['tunde.docs'].action, 'hold');
  assert.match(a['tunde.docs'].message, /runner-up/);
  assert.deepEqual([a.kemi_b.action, a.kemi_b.message], ['hold', 'needs changes, but every paid place is taken']);
});

test('an approval made on the Gibwork site takes a place; a fix request is sent again only for new content', async () => {
  const { state } = await collected('content-brief.yaml');
  const tunde = Object.values(state.submissions).find((s) => s.username === 'tunde.docs')!;
  tunde.reviewStatus = 'approved';
  const plan = planDecisions(state);
  assert.ok(plan.notes.some((n) => /@tunde\.docs was approved outside gibreview; counted as the 1st place/.test(n)));
  const a = byUser(plan.actions);
  assert.deepEqual([a.ada_writes.amount, a.ada_writes.message], ['10.00', '2nd place']);

  const kemi = Object.values(state.submissions).find((s) => s.username === 'kemi_b')!;
  kemi.changesRequested = { at: '2026-10-27T00:00:00Z', message: 'fix it', contentHash: contentHash(kemi.content) };
  assert.equal(byUser(planDecisions(state).actions).kemi_b.action, 'hold');
  kemi.content += ' still broken';
  assert.equal(byUser(planDecisions(state).actions).kemi_b.action, 'request-changes');
});

test('stops paying when Gibwork reports that an approval closed the bounty', async () => {
  const { store, client, state } = await collected('content-brief.yaml');
  const closing: GibworkLike = {
    ...client,
    submissions: {
      ...client.submissions,
      approve: async (...args: Parameters<GibworkLike['submissions']['approve']>) => {
        const res = await client.submissions.approve(...args);
        return { ...res, approvalQuote: { ...res.approvalQuote, closeTask: true } };
      },
    },
  };
  const actions = await applyDecisions(state, closing, store, planDecisions(state));
  const a = byUser(actions);
  assert.equal(a.ada_writes.outcome, 'done');
  assert.equal(a['tunde.docs'].outcome, 'error');
  assert.match(a['tunde.docs'].error!, /Gibwork closed the bounty/);
  assert.equal(a.copycat.outcome, undefined, 'nothing after the stop is sent');
});
