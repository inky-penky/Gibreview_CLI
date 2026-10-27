import { createHash } from 'node:crypto';
import { fromCents, poolPerBatch, toCents } from './plan.js';
import type { RunState } from './state.js';
import type { TriageAction } from './engine.js';

/**
 * Spend guard for the MCP server. An agent can only move funds by quoting a confirm code that is
 * derived from the exact action and amount, so a "yes" given for one budget never covers another.
 * The operator can also cap what any run may put into escrow with GIBREVIEW_MCP_MAX_BUDGET.
 */

export type SpendKind = 'publish' | 'pay';

export interface Spend {
  kind: SpendKind;
  cents: number;
  /** What the code covers: batch ids for publish, submissionId:action pairs for pay. */
  targets: string[];
}

export interface GuardConfig {
  allowProduction: boolean;
  /** Raw GIBREVIEW_MCP_MAX_BUDGET value, in the plan's reward token. Unset means no cap. */
  maxBudget?: string;
}

export class SpendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendRefused';
  }
}

export function publishSpend(run: RunState, batchId?: string): Spend {
  const targets = run.batches.filter((b) => !b.taskId && !b.ambiguous && (!batchId || b.id === batchId)).map((b) => b.id);
  return { kind: 'publish', cents: toCents(poolPerBatch(run.plan)) * targets.length, targets };
}

export function paySpend(actions: TriageAction[]): Spend {
  const acted = actions.filter((a) => a.action !== 'hold');
  return {
    kind: 'pay',
    cents: acted.reduce((n, a) => n + (a.action === 'approve' && a.amount ? toCents(a.amount) : 0), 0),
    targets: acted.map((a) => `${a.submissionId}:${a.action}`),
  };
}

/** e.g. "publish-24.00-USDC-7f3a91". Changes whenever the run, amount or covered targets change. */
export function confirmCode(run: RunState, spend: Spend): string {
  return spendCode(run.runId, run.plan.reward.symbol, spend);
}

/** The same code for any kind of run: bound to the run, the amount and exactly what it covers. */
export function spendCode(runId: string, symbol: string, spend: Spend): string {
  const amount = fromCents(spend.cents);
  const hash = createHash('sha256')
    .update([runId, spend.kind, amount, ...[...spend.targets].sort()].join('\n'))
    .digest('hex')
    .slice(0, 6);
  return `${spend.kind}-${amount}-${symbol}-${hash}`;
}

/** Escrow this run has already funded, so the cap holds across several publish calls. */
function fundedCents(run: RunState): number {
  return toCents(poolPerBatch(run.plan)) * run.batches.filter((b) => b.taskId || b.ambiguous).length;
}

/** Fails closed: a cap that is set but unreadable blocks spending instead of being ignored. */
export function parseMaxBudget(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) {
    throw new SpendRefused(`GIBREVIEW_MCP_MAX_BUDGET="${raw}" is not an amount like "50" or "50.00". Spending is blocked until the operator fixes it.`);
  }
  return toCents(raw.trim());
}

/** Throws if the run's total escrow (already funded plus extraCents) would exceed the operator's cap. */
export function checkBudgetCap(run: RunState, extraCents: number, cfg: GuardConfig): void {
  const cap = parseMaxBudget(cfg.maxBudget);
  if (cap === null) return;
  const total = fundedCents(run) + extraCents;
  if (total > cap) {
    const sym = run.plan.reward.symbol;
    throw new SpendRefused(
      `Run budget ${fromCents(total)} ${sym} is over the operator's cap of ${fromCents(cap)} ${sym} (GIBREVIEW_MCP_MAX_BUDGET). ` +
        'Reduce testers, reward or cases in the plan, or ask the operator to raise the cap. An agent cannot override this.',
    );
  }
}

/**
 * Checks, in order: production permission (operator), budget cap (operator), then the confirm code (user via agent).
 * The refusal for a missing or stale code carries the cost and the code, so the agent can show the user exactly what they approve.
 */
export function guardSpend(run: RunState, spend: Spend, code: string | undefined, cfg: GuardConfig): void {
  if (!spend.targets.length) return; // nothing would be funded, paid or rejected
  if (run.environment === 'production' && !cfg.allowProduction) {
    throw new SpendRefused('Run targets Gibwork production. The server operator must set GIBREVIEW_MCP_ALLOW_PRODUCTION=1 to allow agent spending.');
  }
  if (spend.kind === 'publish') checkBudgetCap(run, spend.cents, cfg);

  const expected = confirmCode(run, spend);
  if (code === expected) return;
  const sym = run.plan.reward.symbol;
  const what =
    spend.kind === 'publish'
      ? `fund ${spend.targets.length} bount${spend.targets.length === 1 ? 'y' : 'ies'} with ${fromCents(spend.cents)} ${sym} of escrow (plus Gibwork fees) on ${run.environment}`
      : `pay ${fromCents(spend.cents)} ${sym} to testers and send ${spend.targets.filter((t) => t.endsWith(':reject')).length} rejections on ${run.environment}`;
  throw new SpendRefused(
    `${code ? 'That confirm code is stale or wrong; the action or amount has changed. ' : ''}` +
      `This will ${what}. Show the user this amount and ask them to approve it. ` +
      `Only after they say yes, call again with confirmCode="${expected}".`,
  );
}
