import { GibworkAmbiguousSubmitError } from '@gibwork/sdk';
import type { CreateTaskInput } from '@gibwork/sdk';
import { describeError, mapReviewStatus } from '../engine.js';
import type { GibworkLike } from '../gibwork.js';
import { fromCents, PlanError, toCents } from '../plan.js';
import type { Environment, ReviewStatus, Store } from '../state.js';
import { missingFields, parseTemplate } from '../template.js';
import { briefContent, briefTemplate, compareRules, minimumPayment, siteCategory, totalPayoutCents, winnerSlots, type Brief } from './brief.js';
import { checkFields, deadlineCheck, findDuplicates, type CheckContext, type CheckResult, type FieldValue } from './checks.js';

export type ReviewVerdict = 'eligible' | 'needs-changes' | 'disqualified' | 'invalid';

export interface Reputation {
  approved: number;
  rejected: number;
  rating: number;
}

export interface ReviewSubmission {
  id: string;
  username: string;
  createdAt: string;
  remoteStatus: string;
  reviewStatus: ReviewStatus;
  content: string;
  fields: Record<string, FieldValue>;
  reputation: Reputation | null;
  checks: CheckResult[];
  verdict: ReviewVerdict;
  /** Set once gibreview pays or rejects it. */
  decision?: ReviewDecision;
  /** Set when gibreview asked for a fix; contentHash says which version of the submission was commented on. */
  changesRequested?: { at: string; message: string; contentHash: string };
}

export interface ReviewDecision {
  action: 'pay' | 'reject';
  at: string;
  /** 1-based place this payment filled. */
  place?: number;
  amount?: string;
  txHash?: string;
  reason?: string;
  /** Done by the creator on the website and recorded with decide --mark-done. */
  manual?: boolean;
}

export interface ReviewTask {
  id?: string;
  title: string;
  deadline: string | null;
  mintAddress: string;
  symbol: string;
  /** Escrow pool as a decimal string in the token's units. */
  pool: string;
  /** Least any approved submission is paid (Gibwork's minSubmissionAmount), in the token's units. */
  minimum?: string;
  publishedBy: 'copilot' | 'attached';
  /**
   * Whether the signing wallet (SOLANA_PRIVATE_KEY) may pay, reject and refund on this bounty. Only the wallet
   * that created a bounty can. false for one made on the website from another wallet or by card: decide then
   * gives a checklist to do on the website instead of paying.
   */
  walletCanPay?: boolean;
  /** attach: whether the bounty text lists the brief's rules, which participants' pre-checks rely on. */
  rules?: 'match' | 'differ' | 'missing';
  txHash?: string;
  /** Set when the SDK could not tell whether the create transaction landed. Never auto-retried. */
  ambiguous?: { intentId: string; message: string };
}

export interface ReviewState {
  version: 1;
  kind: 'review';
  runId: string;
  environment: Environment;
  createdAt: string;
  briefPath?: string;
  brief: Brief;
  task: ReviewTask;
  submissions: Record<string, ReviewSubmission>;
  collectedAt?: string;
  /** Set when the leftover pool was refunded and the bounty closed. */
  closed?: { at: string; txHash: string; refunded?: string };
}

export type ReviewStore = Store<ReviewState>;

export function newReviewId(name: string, now = new Date()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return `${slug}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- publish ----------

export interface PublishPreview {
  pool: string;
  symbol: string;
  maxPayout: string;
  minSubmissionAmount: string;
  deadline: string | null;
}

export function publishPreview(brief: Brief): PublishPreview {
  if (!brief.bounty) throw new PlanError('This brief has no bounty section. Add bounty.pool to publish it, or attach it to an existing bounty instead.');
  if (brief.bounty.access === 'link') {
    throw new PlanError('"Only to those with a Link" can only be set on the Gibwork website.', [
      `Create the bounty there with the text from "gibreview text", then "gibreview attach <taskId> --brief <file>".`,
    ]);
  }
  return {
    pool: brief.bounty.pool,
    symbol: brief.bounty.symbol,
    maxPayout: fromCents(totalPayoutCents(brief)),
    minSubmissionAmount: minimumPayment(brief),
    deadline: brief.bounty.deadlineHours ? new Date(Date.now() + brief.bounty.deadlineHours * 3_600_000).toISOString() : null,
  };
}

/** The SDK fields for the website's "who can participate" options. */
function accessInput(brief: Brief): Partial<CreateTaskInput> {
  const b = brief.bounty!;
  if (b.access === 'verified') return { allowOnlyVerifiedSubmissions: true };
  if (b.access === 'discord' && b.discord) {
    return {
      allowOnlyDiscordGuildSubmissions: true,
      requiredDiscordGuildId: b.discord.guildId,
      requiredDiscordGuildName: b.discord.guildName,
      discordGuildInvitationUrl: b.discord.invite ?? null,
      requiredDiscordRoleIds: b.discord.roleIds,
    };
  }
  return {};
}

/**
 * Creates the run, then funds the bounty through Gibwork escrow. The run is saved before the create call,
 * so an interrupted publish is never repeated blindly.
 */
export async function publishBrief(brief: Brief, briefPath: string, environment: Environment, client: GibworkLike, store: ReviewStore): Promise<ReviewState> {
  const p = publishPreview(brief);
  const runId = newReviewId(brief.name);
  const state: ReviewState = {
    version: 1,
    kind: 'review',
    runId,
    environment,
    createdAt: new Date().toISOString(),
    briefPath,
    brief,
    task: { title: brief.name.slice(0, 120), deadline: p.deadline, mintAddress: brief.bounty!.mintAddress, symbol: p.symbol, pool: p.pool, minimum: p.minSubmissionAmount, publishedBy: 'copilot', walletCanPay: true },
    submissions: {},
  };
  await store.save(state);
  const input: CreateTaskInput = {
    title: state.task.title,
    content: briefContent(brief, runId),
    tags: [...new Set([siteCategory(brief), ...brief.bounty!.tags])],
    payment: { mintAddress: brief.bounty!.mintAddress, amount: p.pool },
    minSubmissionAmount: p.minSubmissionAmount,
    ...(p.deadline ? { deadline: p.deadline } : {}),
    ...accessInput(brief),
  };
  try {
    const created = await client.tasks.create(input);
    state.task.id = created.taskId;
    state.task.txHash = created.txHash;
  } catch (err) {
    if (err instanceof GibworkAmbiguousSubmitError) {
      state.task.ambiguous = { intentId: err.context.intentId, message: describeError(err) };
      await store.save(state);
      throw new Error(`Ambiguous submit, intent ${err.context.intentId} recorded in run ${runId}. Check your wallet before trying again.`);
    }
    throw err;
  }
  await store.save(state);
  return state;
}

// ---------- attach ----------

/** Whether the signing wallet created this bounty and may still pay, reject and refund on it. */
export async function walletCanPay(client: GibworkLike, taskId: string): Promise<boolean> {
  for (let page = 1; ; page++) {
    const res = await client.tasks.list({ page, limit: 100 });
    const own = res.results.find((t) => t.id === taskId);
    if (own) return own.canApprove && own.canReject && own.canRefund;
    if (page >= res.lastPage) return false;
  }
}

/** Reviews a bounty that already exists on Gibwork, for example one created on the website. */
export async function attachTask(taskId: string, brief: Brief, briefPath: string, environment: Environment, client: GibworkLike, store: ReviewStore): Promise<ReviewState> {
  const t = (await client.tasks.get(taskId)) as unknown as {
    id: string;
    title: string;
    content?: string;
    deadline?: string | null;
    minSubmissionAmount?: number | string | null;
    asset?: { mintAddress: string; symbol: string; amount: number | string; decimals: number };
  };
  const decimals = t.asset?.decimals ?? 6;
  // Task details report the pool in base units, like discovery. Two decimals is enough for display.
  const units = (v: number | string) => fromCents(Math.round((Number(v) / 10 ** decimals) * 100));
  const pool = t.asset ? units(t.asset.amount) : '0.00';
  const minimum = t.minSubmissionAmount != null ? units(t.minSubmissionAmount) : undefined;
  const state: ReviewState = {
    version: 1,
    kind: 'review',
    runId: newReviewId(t.title || brief.name),
    environment,
    createdAt: new Date().toISOString(),
    briefPath,
    brief,
    task: { id: t.id, title: t.title, deadline: t.deadline ?? null, mintAddress: t.asset?.mintAddress ?? '', symbol: t.asset?.symbol ?? '?', pool, ...(minimum ? { minimum } : {}), publishedBy: 'attached', walletCanPay: await walletCanPay(client, t.id), rules: compareRules(brief.template, t.content ?? '') },
    submissions: {},
  };
  await store.save(state);
  return state;
}

// ---------- collect ----------

export interface CollectSummary {
  fetched: number;
  newSubmissions: number;
  byVerdict: Record<ReviewVerdict, number>;
}

/**
 * Fetches every submission, parses it against the brief's template and runs the checks.
 * Checks run once per submission; pass recheck to run them again (for example after a participant fixed a link).
 */
export async function collectReview(state: ReviewState, client: GibworkLike, store: ReviewStore, ctx: CheckContext, opts: { recheck?: boolean; log?: (m: string) => void } = {}): Promise<CollectSummary> {
  if (!state.task.id) throw new Error('This run has no Gibwork task yet. Publish it first.');
  const template = briefTemplate(state.brief);
  let fetched = 0;
  let fresh = 0;
  for (let page = 1; ; page++) {
    const res = await client.submissions.list(state.task.id, { page, limit: 100 });
    for (const s of res.results) {
      fetched++;
      const prev = state.submissions[s.id];
      if (!prev) fresh++;
      const user = s.user as { username?: string; approvedTaskSubmissions?: number; rejectedTaskSubmissions?: number; rating?: number } | undefined;
      const sub: ReviewSubmission = {
        id: s.id,
        username: user?.username ?? (s.createdBy as string | undefined) ?? 'unknown',
        createdAt: s.createdAt,
        remoteStatus: s.status,
        reviewStatus: mapReviewStatus(s.status),
        content: s.content,
        fields: {},
        reputation:
          user && typeof user.approvedTaskSubmissions === 'number'
            ? { approved: user.approvedTaskSubmissions, rejected: user.rejectedTaskSubmissions ?? 0, rating: user.rating ?? 0 }
            : null,
        checks: [],
        verdict: 'invalid',
        ...(prev?.decision ? { decision: prev.decision } : {}),
        ...(prev?.changesRequested ? { changesRequested: prev.changesRequested } : {}),
      };
      const parsed = parseTemplate(s.content, template);
      sub.fields = Object.fromEntries([...parsed.fields].map(([k, v]) => [k, { text: v.text, urls: v.urls }]));
      if (prev && !opts.recheck && prev.content === s.content) {
        sub.checks = prev.checks.filter((c) => c.id !== 'duplicate'); // duplicates are recomputed across all below
      } else if (parsed.fields.size) {
        opts.log?.(`Checking @${sub.username}…`);
        const missing = missingFields(template, parsed).map<CheckResult>((f) => ({
          id: 'template',
          field: f.key,
          status: 'fail',
          message: `${f.key} is missing${f.type === 'url' ? ' or has no link' : ''}`,
          fixable: true,
        }));
        const late = deadlineCheck(sub.createdAt, state.task.deadline);
        sub.checks = [...missing, ...(late ? [late] : []), ...(await checkFields(state.brief, sub.fields, ctx))];
      }
      state.submissions[s.id] = sub;
    }
    if (page >= res.lastPage) break;
  }

  const parsedSubs = Object.values(state.submissions).filter((s) => Object.keys(s.fields).length);
  const dups = findDuplicates(parsedSubs, state.brief.review.duplicates);
  for (const s of Object.values(state.submissions)) {
    const d = dups.get(s.id);
    if (d) s.checks = [...s.checks, d];
    s.verdict = verdictOf(s);
  }
  state.collectedAt = new Date().toISOString();
  await store.save(state);

  const byVerdict: Record<ReviewVerdict, number> = { eligible: 0, 'needs-changes': 0, disqualified: 0, invalid: 0 };
  for (const s of Object.values(state.submissions)) byVerdict[s.verdict]++;
  return { fetched, newSubmissions: fresh, byVerdict };
}

export function verdictOf(s: Pick<ReviewSubmission, 'fields' | 'checks'>): ReviewVerdict {
  if (!Object.keys(s.fields).length) return 'invalid';
  const fails = s.checks.filter((c) => c.status === 'fail');
  if (fails.some((c) => !c.fixable)) return 'disqualified';
  if (fails.length) return 'needs-changes';
  return 'eligible';
}

// ---------- rank ----------

export interface RankedEntry {
  /** 1-based place among eligible submissions; null for the rest. */
  place: number | null;
  shortlisted: boolean;
  submission: ReviewSubmission;
  warnings: string[];
  /** Why it is where it is, in one line. */
  reason: string;
}

const VERDICT_ORDER: Record<ReviewVerdict, number> = { eligible: 0, 'needs-changes': 1, disqualified: 2, invalid: 3 };
const repScore = (r: Reputation | null) => (r ? r.approved - 2 * r.rejected + r.rating : 0);

/**
 * Orders submissions: eligible first (fewest warnings, then the brief's tie-breaker), then those that need
 * changes, then disqualified and invalid ones. The first winnerSlots eligible entries are the shortlist.
 * Nothing here decides a payout; that is the creator's call in the decide step.
 */
export function rankReview(state: ReviewState): RankedEntry[] {
  const subs = Object.values(state.submissions);
  const warnCount = (s: ReviewSubmission) => s.checks.filter((c) => c.status === 'warn').length;
  const tieBreak = (a: ReviewSubmission, b: ReviewSubmission) =>
    state.brief.review.order === 'reputation'
      ? repScore(b.reputation) - repScore(a.reputation) || a.createdAt.localeCompare(b.createdAt)
      : a.createdAt.localeCompare(b.createdAt) || repScore(b.reputation) - repScore(a.reputation);
  const ordered = [...subs].sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || warnCount(a) - warnCount(b) || tieBreak(a, b));

  const slots = winnerSlots(state.brief, toCents(state.task.pool));
  let place = 0;
  return ordered.map((s) => {
    const warnings = s.checks.filter((c) => c.status === 'warn').map((c) => c.message);
    const fails = s.checks.filter((c) => c.status === 'fail').map((c) => c.message);
    if (s.verdict === 'eligible') {
      place++;
      const passed = s.checks.filter((c) => c.status === 'pass').length;
      return {
        place,
        shortlisted: place <= slots,
        submission: s,
        warnings,
        reason: `${passed} check${passed === 1 ? '' : 's'} passed${warnings.length ? `, ${warnings.length} unverified` : ''}`,
      };
    }
    const reason =
      s.verdict === 'invalid'
        ? 'no SUBMISSION block: the template was not used'
        : fails.join('; ');
    return { place: null, shortlisted: false, submission: s, warnings, reason };
  });
}
