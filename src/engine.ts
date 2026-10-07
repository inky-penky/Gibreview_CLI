import { GibworkAmbiguousSubmitError, GibworkApiError } from '@gibwork/sdk';
import type { CreateTaskInput } from '@gibwork/sdk';
import { buildBatches, fromCents, loadPlan, poolPerBatch, toCents } from './plan.js';
import { bountyContent, bountyTitle } from './content.js';
import { parseSubmission } from './parser.js';
import { aggregate, type Aggregate } from './aggregate.js';
import { writeReports, type ReportFormat } from './report.js';
import { newRunId, type Environment, type ReviewStatus, type RunState, type Store, type SubmissionState } from './state.js';
import type { GibworkLike } from './gibwork.js';

export type Log = (msg: string) => void;
const silent: Log = () => {};

export function describeError(err: unknown): string {
  if (err instanceof GibworkApiError) {
    const body = err.body as { message?: string | string[] } | undefined;
    const msg = Array.isArray(body?.message) ? body!.message.join('; ') : body?.message;
    return `Gibwork API ${err.status} on ${err.method} ${err.path}${msg ? `: ${msg}` : ''}${err.retryAfter ? ` (retry after ${err.retryAfter})` : ''}`;
  }
  return (err as Error)?.message ?? String(err);
}

// ---------- plan ----------

export interface PlanSummary {
  runId: string;
  environment: Environment;
  batches: Array<{ id: string; title: string; cases: number; pool: string }>;
  totalBudget: string;
  symbol: string;
}

export async function planRun(planPath: string, store: Store, environment: Environment): Promise<{ run: RunState; summary: PlanSummary }> {
  const plan = await loadPlan(planPath);
  const runId = newRunId(plan.name);
  const batches = buildBatches(plan).map((b) => ({ ...b, title: bountyTitle(plan, b), content: bountyContent(plan, b, runId) }));
  const run: RunState = { version: 1, runId, planPath, plan, environment, createdAt: new Date().toISOString(), batches, submissions: {} };
  await store.save(run);
  return { run, summary: summarize(run) };
}

export function summarize(run: RunState): PlanSummary {
  const pool = poolPerBatch(run.plan);
  return {
    runId: run.runId,
    environment: run.environment,
    batches: run.batches.map((b) => ({ id: b.id, title: b.title, cases: b.caseIds.length, pool })),
    totalBudget: fromCents(toCents(pool) * run.batches.length),
    symbol: run.plan.reward.symbol,
  };
}

// ---------- publish ----------

export interface PublishResult {
  published: Array<{ batchId: string; taskId: string; txHash?: string }>;
  skipped: string[];
  failed: Array<{ batchId: string; error: string }>;
  stoppedEarly: boolean;
}

export async function publishRun(run: RunState, client: GibworkLike, store: Store, opts: { batchId?: string; log?: Log } = {}): Promise<PublishResult> {
  const log = opts.log ?? silent;
  const { plan } = run;
  const result: PublishResult = { published: [], skipped: [], failed: [], stoppedEarly: false };
  const targets = run.batches.filter((b) => !opts.batchId || b.id === opts.batchId);
  if (opts.batchId && !targets.length) throw new Error(`No batch "${opts.batchId}" in run ${run.runId}`);

  for (const batch of targets) {
    if (batch.taskId) {
      result.skipped.push(batch.id);
      continue;
    }
    if (batch.ambiguous) {
      result.failed.push({ batchId: batch.id, error: `Previous create is unresolved (intent ${batch.ambiguous.intentId}). Check your wallet before retrying.` });
      continue;
    }
    const input: CreateTaskInput = {
      title: batch.title,
      content: batch.content,
      tags: plan.tags,
      payment: { mintAddress: plan.reward.mintAddress, amount: poolPerBatch(plan) },
      minSubmissionAmount: plan.reward.perTester,
      allowOnlyVerifiedSubmissions: plan.verifiedTestersOnly,
      ...(plan.deadlineHours ? { deadline: new Date(Date.now() + plan.deadlineHours * 3_600_000).toISOString() } : {}),
    };
    log(`Publishing ${batch.id}…`);
    try {
      const created = await client.tasks.create(input);
      batch.taskId = created.taskId;
      batch.txHash = created.txHash;
      batch.publishedAt = new Date().toISOString();
      result.published.push({ batchId: batch.id, taskId: created.taskId, txHash: created.txHash });
      await store.save(run);
    } catch (err) {
      if (err instanceof GibworkAmbiguousSubmitError) {
        // The funding transaction may have landed. Record it and never resend blindly.
        batch.ambiguous = { intentId: err.context.intentId, message: describeError(err) };
        await store.save(run);
        result.failed.push({ batchId: batch.id, error: `Ambiguous submit, intent ${err.context.intentId} recorded. Not retrying.` });
        result.stoppedEarly = true;
        break;
      }
      result.failed.push({ batchId: batch.id, error: describeError(err) });
      if (err instanceof GibworkApiError && err.status === 429) {
        result.stoppedEarly = true; // rate limited; rerunning publish skips what already went out
        break;
      }
    }
  }
  return result;
}

// ---------- collect ----------

function mapReviewStatus(status: string): ReviewStatus {
  if (status === 'OPEN') return 'pending';
  if (status === 'REJECTED') return 'rejected';
  return 'approved';
}

export interface CollectResult {
  fetched: number;
  newSubmissions: number;
  byBatch: Record<string, { total: number; valid: number; incomplete: number; invalid: number }>;
}

export async function collectRun(run: RunState, client: GibworkLike, store: Store, log: Log = silent): Promise<CollectResult> {
  const out: CollectResult = { fetched: 0, newSubmissions: 0, byBatch: {} };
  for (const batch of run.batches.filter((b) => b.taskId)) {
    log(`Collecting ${batch.id}…`);
    let page = 1;
    for (;;) {
      const res = await client.submissions.list(batch.taskId!, { page, limit: 100 });
      for (const s of res.results) {
        out.fetched++;
        const existing = run.submissions[s.id];
        const parsed = parseSubmission(s.content, batch.caseIds);
        const user = (s.user as { username?: string } | undefined)?.username ?? (s.createdBy as string | undefined) ?? 'unknown';
        if (!existing) out.newSubmissions++;
        const next: SubmissionState = {
          id: s.id,
          taskId: batch.taskId!,
          batchId: batch.id,
          username: user,
          createdAt: s.createdAt,
          reviewStatus: mapReviewStatus(s.status),
          content: s.content,
          parsed,
          ...(existing?.decision ? { decision: existing.decision } : {}),
        };
        run.submissions[s.id] = next;
      }
      if (page >= res.lastPage) break;
      page++;
    }
    const mine = Object.values(run.submissions).filter((s) => s.batchId === batch.id);
    out.byBatch[batch.id] = {
      total: mine.length,
      valid: mine.filter((s) => s.parsed.verdict === 'valid').length,
      incomplete: mine.filter((s) => s.parsed.verdict === 'incomplete').length,
      invalid: mine.filter((s) => s.parsed.verdict === 'invalid').length,
    };
  }
  run.collectedAt = new Date().toISOString();
  await store.save(run);
  return out;
}

// ---------- triage ----------

export interface TriageAction {
  submissionId: string;
  batchId: string;
  username: string;
  action: 'approve' | 'reject' | 'hold';
  amount?: string;
  reason: string;
  outcome?: 'done' | 'error';
  error?: string;
}

/**
 * Pays complete, evidenced work first come first served until each bounty's tester slots are filled.
 * Rejects incomplete or spam work with a reason the tester can act on.
 */
export function planTriage(run: RunState): TriageAction[] {
  const actions: TriageAction[] = [];
  const { perTester, testersPerBatch } = run.plan.reward;
  for (const batch of run.batches) {
    const subs = Object.values(run.submissions)
      .filter((s) => s.batchId === batch.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let slots = testersPerBatch - subs.filter((s) => s.reviewStatus === 'approved').length;
    for (const s of subs.filter((x) => x.reviewStatus === 'pending')) {
      if (s.parsed.verdict === 'valid') {
        if (slots > 0) {
          slots--;
          actions.push({ submissionId: s.id, batchId: batch.id, username: s.username, action: 'approve', amount: perTester, reason: `All ${batch.caseIds.length} cases reported with evidence` });
        } else {
          actions.push({ submissionId: s.id, batchId: batch.id, username: s.username, action: 'hold', reason: 'Valid, but every paid tester slot is already filled' });
        }
      } else {
        const reason =
          s.parsed.verdict === 'invalid'
            ? 'No BUGBASH RESULT block found. Please resubmit using the template in the bounty, one line per case.'
            : `Incomplete. ${s.parsed.issues.join('. ')}. Please resubmit with every case filled in and an evidence link for each FAIL.`;
        actions.push({ submissionId: s.id, batchId: batch.id, username: s.username, action: 'reject', reason });
      }
    }
  }
  return actions;
}

export async function applyTriage(run: RunState, client: GibworkLike, store: Store, actions: TriageAction[], log: Log = silent): Promise<TriageAction[]> {
  for (const a of actions) {
    if (a.action === 'hold') continue;
    const sub = run.submissions[a.submissionId];
    try {
      if (a.action === 'approve') {
        log(`Approving @${a.username} on ${a.batchId}…`);
        const res = await client.submissions.approve(sub.taskId, sub.id, { amount: a.amount!, rating: 5 });
        sub.reviewStatus = 'approved';
        sub.decision = { action: 'approve', at: new Date().toISOString(), amount: a.amount, txHash: res.txHash };
      } else {
        log(`Rejecting @${a.username} on ${a.batchId}…`);
        await client.submissions.reject(sub.taskId, sub.id, a.reason);
        sub.reviewStatus = 'rejected';
        sub.decision = { action: 'reject', at: new Date().toISOString(), reason: a.reason };
      }
      a.outcome = 'done';
      await store.save(run);
    } catch (err) {
      a.outcome = 'error';
      a.error = describeError(err);
      if (err instanceof GibworkAmbiguousSubmitError) {
        a.error += '. Payout may have been sent; check before retrying. Stopping.';
        break;
      }
    }
  }
  return actions;
}

// ---------- report ----------

export async function reportRun(run: RunState, outDir: string, formats: ReportFormat[]): Promise<{ agg: Aggregate; files: string[] }> {
  const agg = aggregate(run);
  const files = await writeReports(run, agg, outDir, formats);
  return { agg, files };
}

export function gateExitCode(agg: Aggregate): number {
  return { PASS: 0, FAIL: 1, INCOMPLETE: 2 }[agg.gate.verdict];
}

// ---------- refund ----------

export async function refundRun(run: RunState, client: GibworkLike, store: Store, log: Log = silent) {
  const out: Array<{ batchId: string; ok: boolean; detail: string }> = [];
  for (const b of run.batches.filter((x) => x.taskId && !x.refundedAt)) {
    log(`Refunding ${b.id}…`);
    try {
      const r = await client.tasks.refund(b.taskId!);
      b.refundedAt = new Date().toISOString();
      out.push({ batchId: b.id, ok: true, detail: `tx ${r.txHash}` });
      await store.save(run);
    } catch (err) {
      out.push({ batchId: b.id, ok: false, detail: describeError(err) });
      if (err instanceof GibworkAmbiguousSubmitError) break;
    }
  }
  return out;
}
