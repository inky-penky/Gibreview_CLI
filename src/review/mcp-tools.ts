import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createClient } from '../gibwork.js';
import { Store, type Environment } from '../state.js';
import { SpendRefused } from '../spendguard.js';
import { loadBrief, websiteGuide } from './brief.js';
import type { CheckContext } from './checks.js';
import { applyDecisions, closePreview, closeReview, decisionCode, planDecisions, recordDecisions, websiteChecklist } from './decide.js';
import { attachTask, collectReview, rankReview, type ReviewState } from './engine.js';
import { mockFetch } from './mockweb.js';
import { precheck } from './precheck.js';
import { writeShortlist } from './report.js';
import { scoreReview } from './score.js';

/**
 * MCP tools for bounty creators (review_*) and participants (review_precheck). A creator's agent can
 * review, rank and plan a bounty end to end. Paying needs the confirm code of the exact plan, and on
 * production the operator's GIBREVIEW_MCP_ALLOW_PRODUCTION=1. Bounties made on gibwork.com belong to the
 * account's own wallet, so for those the agent gets a checklist for the user to do on the website.
 */

type Reply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ReviewToolsConfig {
  stateRoot: string;
  allowProduction: boolean;
  ok: (data: unknown) => Reply;
  fail: (err: unknown) => Reply;
}

export function registerReviewTools(server: McpServer, cfg: ReviewToolsConfig) {
  const store = new Store<ReviewState>(cfg.stateRoot, 'Start one with review_attach.');
  const client = (env: Environment) => createClient({ environment: env, stateDir: cfg.stateRoot });
  const checkContext = (env: Environment): CheckContext =>
    env === 'mock' ? { fetch: mockFetch } : { fetch: globalThis.fetch as unknown as CheckContext['fetch'], githubToken: process.env.GITHUB_TOKEN };
  const runId = z.string().optional().describe('Review run id. Defaults to the most recent run.');
  const confirmCode = z.string().optional().describe('Code from the decide dry run. Pass it only after the user has seen that plan and approved it.');
  const environment = z.enum(['stage', 'production', 'mock']).default('production').describe('Gibwork environment of the bounty. Bounties made on gibwork.com are on production.');
  const guardProduction = (state: ReviewState) => {
    if (state.environment === 'production' && !cfg.allowProduction) {
      throw new SpendRefused('This bounty is on Gibwork production. The server operator must set GIBREVIEW_MCP_ALLOW_PRODUCTION=1 to let agents pay or refund.');
    }
  };
  const tool = <A extends Record<string, z.ZodType>>(name: string, meta: { title: string; description: string; readOnly?: boolean }, input: A, run: (args: z.infer<z.ZodObject<A>>) => Promise<unknown>) =>
    server.registerTool(name, { title: meta.title, description: meta.description, inputSchema: input, ...(meta.readOnly ? { annotations: { readOnlyHint: true } } : {}) }, (async (args: z.infer<z.ZodObject<A>>) => {
      try {
        return cfg.ok(await run(args));
      } catch (e) {
        return cfg.fail(e);
      }
    }) as never);

  tool(
    'review_text',
    {
      title: 'Bounty text for the Gibwork website',
      description:
        'Turn a brief into what the user enters on "Create Bounty" at gibwork.com: title, category, who can participate, due date, custom minimum, the description to paste, and the bounty amount to pick on the payment page. ' +
        'Show the user each step. They create and pay for the bounty on the website from their Gibwork account wallet, then give you the task id for review_attach.',
      readOnly: true,
    },
    { briefPath: z.string().describe('Path to the brief (.yaml or .json)') },
    async ({ briefPath }) => websiteGuide(await loadBrief(resolve(briefPath))),
  );

  tool(
    'review_attach',
    {
      title: 'Start reviewing a bounty',
      description: 'Attach a review run to an existing Gibwork bounty, using a brief for its template, checks and payout. Read-only on Gibwork. Reports whether this server can pay on the bounty, and any mismatch between the brief and the bounty.',
    },
    { taskId: z.string(), briefPath: z.string(), environment },
    async ({ taskId, briefPath, environment: env }) => {
      const brief = await loadBrief(resolve(briefPath));
      const state = await attachTask(taskId, brief, resolve(briefPath), env, client(env), store);
      const below = state.task.minimum ? brief.payout.amounts.filter((a) => Number(a) < Number(state.task.minimum)) : [];
      return {
        runId: state.runId,
        title: state.task.title,
        pool: `${state.task.pool} ${state.task.symbol}`,
        minimumPerApproved: state.task.minimum ?? null,
        payments: state.task.walletCanPay ? 'this server can pay, reject and refund on this bounty' : 'made on gibwork.com: the user pays, rejects and refunds on the website; review_decide gives the checklist',
        warnings: [
          ...(below.length ? [`Payout amounts ${below.join(', ')} are below the bounty's minimum per approved submission (${state.task.minimum}); those places will be held.`] : []),
          ...(state.task.rules === 'missing' ? ['The bounty text lists no rules, so participants cannot pre-check. Suggest pasting the review_text description into the bounty.'] : []),
          ...(state.task.rules === 'differ' ? ["The bounty text's rules differ from the brief; participants pre-check against the bounty."] : []),
        ],
      };
    },
  );

  tool(
    'review_collect',
    { title: 'Collect and check submissions', description: 'Fetch every submission and run the checks. Moves no money.' },
    { runId, recheck: z.boolean().default(false).describe('Run every check again, e.g. after participants fixed links') },
    async ({ runId: id, recheck }) => store.withRun(id, (state) => collectReview(state, client(state.environment), store, checkContext(state.environment), { recheck })),
  );

  tool(
    'review_score',
    {
      title: 'AI rubric scores',
      description: "Score eligible submissions against the brief's criteria with Claude. Optional and advisory; needs ANTHROPIC_API_KEY in the server's environment. Submissions and their linked pages are sent to Anthropic.",
    },
    { runId },
    async ({ runId: id }) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in the MCP server's environment. Scoring is optional; review_rank works without it.");
      return store.withRun(id, (state) => scoreReview(state, store, checkContext(state.environment), { apiKey }));
    },
  );

  tool(
    'review_rank',
    { title: 'Ranked shortlist', description: 'The ranked shortlist with a reason for every verdict, and review.md / review.json written to outDir. Show the user the shortlist before any decision.', readOnly: true },
    { runId, outDir: z.string().default('review-report') },
    async ({ runId: id, outDir }) => {
      const state = await store.load(id);
      const ranked = rankReview(state);
      const files = await writeShortlist(state, ranked, resolve(outDir));
      return {
        shortlist: ranked.map((r) => ({ place: r.place, shortlisted: r.shortlisted, username: r.submission.username, verdict: r.submission.verdict, reason: r.reason, unverified: r.warnings })),
        files,
      };
    },
  );

  tool(
    'review_decide',
    {
      title: 'Decide who is paid, asked to fix, or rejected',
      description:
        'Without apply or markDone: a dry run returning the plan, the total, notes and a confirmCode. Show the user every action and the total. ' +
        'If the bounty was made on gibwork.com, the result has a website checklist: the user does those steps on gibwork.com, and only after they say they are done, call again with markDone=true and the confirmCode. ' +
        'Otherwise, only after the user approves the exact total, call with apply=true and the confirmCode to pay, comment and reject through Gibwork. A changed plan gives a new code.',
    },
    { runId, apply: z.boolean().default(false), markDone: z.boolean().default(false), confirmCode },
    async ({ runId: id, apply, markDone, confirmCode: code }) =>
      store.withRun(id, async (state) => {
        if (!state.collectedAt) throw new Error('No submissions collected yet. Call review_collect first.');
        const plan = planDecisions(state);
        const expected = decisionCode(state, plan);
        const byHand = state.task.walletCanPay === false;
        const summary = {
          mode: byHand ? 'website' : 'pay-here',
          actions: plan.actions.map((a) => ({ username: a.username, action: a.action, amount: a.amount ?? null, message: a.message })),
          payTotal: `${(plan.payCents / 100).toFixed(2)} ${state.task.symbol}`,
          notes: plan.notes,
          confirmCode: expected,
          ...(byHand ? { websiteChecklist: websiteChecklist(plan, state.task.symbol) } : {}),
        };
        if (!expected || (!apply && !markDone)) return summary;
        if (code !== expected) {
          throw new SpendRefused(`${code ? 'That confirm code is for a different plan; submissions or amounts changed. ' : ''}Show the user this plan and ask them to approve it, then call again with confirmCode="${expected}".`);
        }
        if (markDone) return { recorded: (await recordDecisions(state, store, plan)).filter((a) => a.outcome === 'done').length, note: 'Recorded as done on the website. Nothing was sent to Gibwork.' };
        if (byHand) throw new SpendRefused('This bounty was made on gibwork.com, so only the user can pay on it there. Give them the websiteChecklist, then use markDone.');
        guardProduction(state);
        const actions = await applyDecisions(state, client(state.environment), store, plan);
        return { actions: actions.map((a) => ({ username: a.username, action: a.action, amount: a.amount ?? null, outcome: a.outcome ?? 'skipped', error: a.error })) };
      }),
  );

  tool(
    'review_close',
    {
      title: 'Close the bounty',
      description: 'Without confirm: what was paid, what is left and anything still undecided. With confirm=true, refunds what nobody won (only for bounties this server can pay on, and never while planned winners are unpaid). For bounties made on gibwork.com, tells the user to refund on the website.',
    },
    { runId, confirm: z.boolean().default(false) },
    async ({ runId: id, confirm }) =>
      store.withRun(id, async (state) => {
        if (state.closed) return { closed: state.closed };
        const p = closePreview(state);
        const preview = { paid: p.paid, left: p.left, undecided: p.undecided, unpaidWinners: p.unpaidWinners.map((a) => `@${a.username} ${a.amount}`) };
        if (state.task.walletCanPay === false) return { ...preview, next: p.left === '0.00' ? 'Nothing is left to refund.' : `The user refunds ${p.left} ${state.task.symbol} on gibwork.com.` };
        if (!confirm) return preview;
        if (p.unpaidWinners.length) throw new SpendRefused('Planned winners are still unpaid. Run review_decide first; closing anyway is a human decision (gibreview close --force).');
        guardProduction(state);
        return { closed: await closeReview(state, client(state.environment), store) };
      }),
  );

  tool(
    'review_status',
    { title: 'Review run status', description: 'The review run: bounty, pool, who can pay, submissions, payments and whether it is closed.', readOnly: true },
    { runId },
    async ({ runId: id }) => {
      const s = await store.load(id);
      const subs = Object.values(s.submissions);
      return {
        runId: s.runId,
        bounty: s.task.title,
        taskId: s.task.id ?? null,
        environment: s.environment,
        pool: `${s.task.pool} ${s.task.symbol}`,
        payments: s.task.walletCanPay === false ? 'on gibwork.com' : 'by this server',
        submissions: subs.length,
        paid: subs.filter((x) => x.decision?.action === 'pay').map((x) => `@${x.username} ${x.decision!.amount}`),
        collectedAt: s.collectedAt ?? null,
        closed: s.closed ?? null,
      };
    },
  );

  tool(
    'review_precheck',
    {
      title: 'Check a bounty submission before sending it',
      description:
        "For participants: run a bounty's automated checks on a draft submission before submitting it. Read-only and free: nothing is submitted and no funds move. " +
        'Rules come from the bounty text when it was made with gibreview. Show the user every failed check and the summary, and suggest fixes for fixable ones.',
      readOnly: true,
    },
    {
      taskId: z.string().describe('Gibwork task id of the bounty'),
      submission: z.string().min(1).describe('The draft submission text, including the SUBMISSION block'),
      environment,
    },
    async ({ taskId, submission, environment: env }) => {
      const task = (await client(env).tasks.get(taskId)) as unknown as { title: string; content: string; deadline?: string | null };
      return { bounty: task.title, ...(await precheck({ content: task.content, deadline: task.deadline ?? null }, submission, checkContext(env))) };
    },
  );
}
