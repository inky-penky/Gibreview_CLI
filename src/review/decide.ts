import { createHash } from 'node:crypto';
import { GibworkAmbiguousSubmitError } from '@gibwork/sdk';
import { describeError } from '../engine.js';
import type { GibworkLike } from '../gibwork.js';
import { fromCents, toCents } from '../plan.js';
import { spendCode, type Spend } from '../spendguard.js';
import { ordinal, placeAmount, winnerSlots } from './brief.js';
import { rankReview, type ReviewState, type ReviewStore } from './engine.js';

/**
 * Turns the ranking into decisions: pay the winners by the brief's payout rule, ask for fixes where a
 * failed check is fixable, reject what is invalid or disqualified, and hold everything else for the creator.
 * Applying needs the confirm code of the exact plan, so a plan that changed since the creator saw it is refused.
 */

export type DecisionKind = 'pay' | 'request-changes' | 'reject' | 'hold';

export interface ReviewAction {
  submissionId: string;
  username: string;
  action: DecisionKind;
  /** pay: the 1-based place this payment fills. */
  place?: number;
  amount?: string;
  /** pay: what the place is. request-changes: the comment. reject: the reason. hold: why nothing happens yet. */
  message: string;
  outcome?: 'done' | 'error';
  error?: string;
}

export interface DecisionPlan {
  actions: ReviewAction[];
  /** What this plan pays. */
  payCents: number;
  /** Already paid out of this bounty, before this plan. */
  paidCents: number;
  poolCents: number;
  notes: string[];
}

export const contentHash = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 12);

const failures = (checks: ReviewState['submissions'][string]['checks'], fixable: boolean) =>
  checks.filter((c) => c.status === 'fail' && c.fixable === fixable).map((c) => c.message);

export function changesComment(fixes: string[]): string {
  return `Thanks for your submission. It can't be accepted yet: ${fixes.join('; ')}. Please fix ${fixes.length === 1 ? 'this' : 'these'} and reply here when it's done.`;
}

export function planDecisions(state: ReviewState, now = new Date()): DecisionPlan {
  const { brief } = state;
  const sym = state.task.symbol;
  const poolCents = toCents(state.task.pool);
  const subs = Object.values(state.submissions);
  const notes: string[] = [];
  if (state.closed) return { actions: [], payCents: 0, paidCents: 0, poolCents, notes: ['This bounty is closed; nothing more can be paid.'] };

  // Places already filled. Payments made on the Gibwork site have no known place, so each takes the next free one.
  const slots = winnerSlots(brief, poolCents);
  const taken = new Set(subs.flatMap((s) => (s.decision?.action === 'pay' && s.decision.place ? [s.decision.place] : [])));
  const free = Array.from({ length: slots }, (_, i) => i + 1).filter((p) => !taken.has(p));
  let paidCents = subs.reduce((n, s) => n + (s.decision?.action === 'pay' && s.decision.amount ? toCents(s.decision.amount) : 0), 0);
  for (const s of subs.filter((x) => x.reviewStatus === 'approved' && x.decision?.action !== 'pay')) {
    const place = free.shift();
    if (place) paidCents += toCents(placeAmount(brief, place));
    notes.push(`@${s.username} was approved outside gibreview; counted as ${place ? `the ${ordinal(place)} place (${placeAmount(brief, place)} ${sym})` : 'an extra winner'}.`);
  }
  if (!slots) notes.push(`The pool of ${state.task.pool} ${sym} cannot cover one payment of ${brief.payout.amounts[0]} ${sym}.`);
  if (state.task.deadline && new Date(state.task.deadline) > now) {
    notes.push(`The deadline (${state.task.deadline}) has not passed. A place paid now cannot go to a better submission that arrives later.`);
  }

  const actions: ReviewAction[] = [];
  let payCents = 0;
  for (const r of rankReview(state)) {
    const s = r.submission;
    if (s.decision || s.reviewStatus === 'approved' || s.reviewStatus === 'rejected') continue;
    const base = { submissionId: s.id, username: s.username };
    if (s.reviewStatus === 'other') {
      actions.push({ ...base, action: 'hold', message: `Gibwork shows ${s.remoteStatus}; check it on the site` });
      continue;
    }
    if (s.verdict === 'eligible') {
      const place = free[0];
      if (!place) {
        actions.push({ ...base, action: 'hold', message: 'eligible, but every paid place is taken (runner-up)' });
        continue;
      }
      const amount = placeAmount(brief, place);
      const left = poolCents - paidCents - payCents;
      if (toCents(amount) > left) {
        actions.push({ ...base, action: 'hold', message: `eligible, but ${amount} ${sym} is more than the ${fromCents(left)} ${sym} left in the pool` });
        continue;
      }
      free.shift();
      payCents += toCents(amount);
      const label = brief.payout.rule === 'pool' ? 'accepted' : brief.payout.rule === 'one-winner' ? 'winner' : `${ordinal(place)} place`;
      actions.push({ ...base, action: 'pay', place, amount, message: label });
    } else if (s.verdict === 'needs-changes') {
      const asked = s.changesRequested;
      if (!free.length) {
        // Asking for a fix with no place left to win would cost the participant work for nothing.
        actions.push({ ...base, action: 'hold', message: 'needs changes, but every paid place is taken' });
      } else if (asked && asked.contentHash === contentHash(s.content)) {
        actions.push({ ...base, action: 'hold', message: `waiting for @${s.username} to fix it (asked ${asked.at.slice(0, 10)})` });
      } else {
        actions.push({ ...base, action: 'request-changes', message: changesComment(failures(s.checks, true)) });
      }
    } else if (s.verdict === 'disqualified') {
      actions.push({ ...base, action: 'reject', message: `Not accepted: ${failures(s.checks, false).join('; ')}.` });
    } else {
      actions.push({ ...base, action: 'reject', message: 'Not accepted: the submission does not use the SUBMISSION block from the bounty description.' });
    }
  }
  const fixing = actions.filter((a) => a.action === 'request-changes' || (a.action === 'hold' && a.message.startsWith('waiting'))).length;
  if (free.length && fixing) {
    notes.push(`${free.length} paid place${free.length === 1 ? ' is' : 's are'} still open and ${fixing} submission${fixing === 1 ? ' is' : 's are'} being fixed. Closing the bounty now ends their chance.`);
  }
  return { actions, payCents, paidCents, poolCents, notes };
}

/** What the confirm code covers: the total paid and every action, including each payment's amount. */
export function decisionSpend(plan: DecisionPlan): Spend {
  const acted = plan.actions.filter((a) => a.action !== 'hold');
  return { kind: 'pay', cents: plan.payCents, targets: acted.map((a) => `${a.submissionId}:${a.action}:${a.amount ?? ''}`) };
}

/** null when the plan does nothing, so there is nothing to confirm. */
export function decisionCode(state: ReviewState, plan: DecisionPlan): string | null {
  const spend = decisionSpend(plan);
  return spend.targets.length ? spendCode(state.runId, state.task.symbol, spend) : null;
}

/**
 * Executes the plan in order (payments first, by place). The run is saved after every action, so an
 * interrupted run resumes without paying anyone twice. Stops at an ambiguous payment, and stops paying
 * if Gibwork reports that an approval closed the bounty.
 */
export async function applyDecisions(state: ReviewState, client: GibworkLike, store: ReviewStore, plan: DecisionPlan, log: (m: string) => void = () => {}): Promise<ReviewAction[]> {
  const taskId = state.task.id;
  if (!taskId) throw new Error('This run has no Gibwork task.');
  const acted = plan.actions.filter((a) => a.action !== 'hold');
  for (const [i, a] of acted.entries()) {
    const s = state.submissions[a.submissionId];
    const at = new Date().toISOString();
    try {
      if (a.action === 'pay') {
        log(`Paying @${a.username} ${a.amount} ${state.task.symbol}…`);
        const res = await client.submissions.approve(taskId, s.id, { amount: a.amount! });
        s.decision = { action: 'pay', at, place: a.place, amount: a.amount, txHash: res.txHash };
        s.reviewStatus = 'approved';
        a.outcome = 'done';
        await store.save(state);
        const unpaid = acted.slice(i + 1).filter((x) => x.action === 'pay');
        if (res.approvalQuote?.closeTask && unpaid.length) {
          for (const x of unpaid) Object.assign(x, { outcome: 'error', error: 'not paid: Gibwork closed the bounty after the previous payment' });
          break;
        }
      } else if (a.action === 'reject') {
        log(`Rejecting @${a.username}…`);
        await client.submissions.reject(taskId, s.id, a.message);
        s.decision = { action: 'reject', at, reason: a.message };
        s.reviewStatus = 'rejected';
        a.outcome = 'done';
        await store.save(state);
      } else {
        log(`Asking @${a.username} for a fix…`);
        await client.submissions.comments.create(taskId, s.id, a.message);
        s.changesRequested = { at, message: a.message, contentHash: contentHash(s.content) };
        a.outcome = 'done';
        await store.save(state);
      }
    } catch (err) {
      a.outcome = 'error';
      a.error = describeError(err);
      if (err instanceof GibworkAmbiguousSubmitError) {
        a.error += '. The payment may have been sent; check the wallet before running decide again. Stopping.';
        break;
      }
    }
  }
  return plan.actions;
}

// ---------- close ----------

export interface ClosePreview {
  paid: string;
  /** Pool minus what was paid, before any Gibwork refund fee. */
  left: string;
  /** Payments the current plan would still make. Closing first means those winners are never paid. */
  unpaidWinners: ReviewAction[];
  /** Submissions nobody decided yet: held, or waiting for a fix. They stay as they are on Gibwork. */
  undecided: number;
}

export function closePreview(state: ReviewState): ClosePreview {
  const plan = planDecisions(state);
  return {
    paid: fromCents(plan.paidCents),
    left: fromCents(Math.max(0, plan.poolCents - plan.paidCents)),
    unpaidWinners: plan.actions.filter((a) => a.action === 'pay'),
    undecided: plan.actions.filter((a) => a.action !== 'pay').length,
  };
}

/** Refunds what nobody won and records it. Gibwork returns the leftover escrow to the creator. */
export async function closeReview(state: ReviewState, client: GibworkLike, store: ReviewStore): Promise<NonNullable<ReviewState['closed']>> {
  if (!state.task.id) throw new Error('This run has no Gibwork task.');
  if (state.closed) throw new Error(`This bounty was already closed on ${state.closed.at}.`);
  try {
    const r = await client.tasks.refund(state.task.id);
    state.closed = { at: new Date().toISOString(), txHash: r.txHash, refunded: r.refundQuote?.netRefundAmount };
  } catch (err) {
    if (err instanceof GibworkAmbiguousSubmitError) {
      throw new Error(`${describeError(err)}. The refund may have gone through; check the wallet before trying again.`);
    }
    throw err;
  }
  await store.save(state);
  return state.closed;
}
