#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient, loadEnvFiles } from './gibwork.js';
import { Store } from './state.js';
import { htmlToText } from './content.js';
import { fromCents, PlanError } from './plan.js';
import { applyTriage, collectRun, describeError, planRun, planTriage, publishRun, reportRun, summarize } from './engine.js';
import { attentionNotes } from './report.js';
import { checkBudgetCap, confirmCode, guardSpend, paySpend, publishSpend, type GuardConfig } from './spendguard.js';

loadEnvFiles();

/**
 * MCP server so a coding agent can run a human QA pass as part of shipping:
 * "run the checkout regression on real phones and tell me if v2.3.0 is safe to release".
 *
 * Money-moving tools (publish, triage apply) need a confirmCode tied to the exact amount and action,
 * which the agent gets alongside the cost it must show the user. The operator controls the rest from
 * the server's environment, which an agent cannot change: GIBREVIEW_MCP_ALLOW_PRODUCTION=1 to spend on
 * production, and GIBREVIEW_MCP_MAX_BUDGET to cap what any run may put into escrow.
 */

/** GIBREVIEW_DIR is the state root (default .gibreview); review runs live in it, QA runs in its qa folder. */
const stateRoot = resolve(process.env.GIBREVIEW_DIR ?? '.gibreview');
const store = new Store(join(stateRoot, 'qa'));
const guard: GuardConfig = {
  allowProduction: process.env.GIBREVIEW_MCP_ALLOW_PRODUCTION === '1',
  maxBudget: process.env.GIBREVIEW_MCP_MAX_BUDGET,
};

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof PlanError ? `${err.message}\n${err.issues.map((i) => `- ${i}`).join('\n')}` : describeError(err) }],
});

const server = new McpServer({ name: 'gibreview', version: '0.1.0' });
const runId = z.string().optional().describe('Run id. Defaults to the most recent run.');
const confirmCodeArg = z
  .string()
  .optional()
  .describe('Code from the cost preview. Pass it only after the user has seen that amount and approved it.');

server.registerTool(
  'qa_generate_plan',
  {
    title: 'Draft a test plan from a URL',
    description:
      'Read a feature page and draft manual test cases as a YAML test plan marked draft: true. The user must review it and remove draft: true before qa_plan accepts it. Show the user the cases and any review notes.',
    inputSchema: {
      url: z.string().url(),
      outPath: z.string().default('testplan.yaml'),
      describe: z.string().optional().describe('What the feature should do, used by the AI writer'),
      maxCases: z.number().int().min(1).max(40).default(12),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ url, outPath, describe, maxCases, overwrite }) => {
    try {
      const { generatePlan, writePlanFile } = await import('./generate/index.js');
      const res = await generatePlan({ url, describe, maxCases });
      await writePlanFile(resolve(outPath), res.yaml, overwrite);
      return ok({
        file: resolve(outPath),
        draft: true,
        writer: res.source,
        readVia: res.page.renderedWith,
        warnings: res.warnings,
        cases: res.plan.cases.map((c) => ({ id: c.id, priority: c.priority, title: c.title, expected: c.expected, reviewNote: c.reviewNote })),
        next: 'Ask the user to review the file, resolve review notes and delete "draft: true", then call qa_plan.',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_import_csv',
  {
    title: 'Import test cases from CSV',
    description:
      'Convert a CSV/TSV of test cases (Excel, Google Sheets, TestRail, Zephyr, Xray exports) into a gibreview test plan. Columns are matched by name and priorities normalised. Returns the column mapping and any warnings to show the user.',
    inputSchema: {
      csvPath: z.string(),
      url: z.string().url().describe('Build or staging URL testers should open'),
      outPath: z.string().default('testplan.yaml'),
      name: z.string().optional(),
      link: z.boolean().default(false).describe('Reference the CSV instead of copying cases in'),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ csvPath, url, outPath, name, link, overwrite }) => {
    try {
      const { importCsvPlan } = await import('./importplan.js');
      const { writePlanFile } = await import('./generate/index.js');
      const res = await importCsvPlan({ csvPath: resolve(csvPath), outPath: resolve(outPath), url, name, link });
      await writePlanFile(resolve(outPath), res.yaml, overwrite);
      return ok({
        file: resolve(outPath),
        columns: res.csv.columns,
        ignoredColumns: res.csv.ignoredColumns,
        warnings: res.csv.warnings,
        cases: res.plan.cases.map((c) => ({ id: c.id, priority: c.priority, title: c.title, steps: c.steps.length })),
        next: 'Show the user the mapping and warnings, then call qa_plan with this file.',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_plan',
  {
    title: 'Plan a crowd QA run',
    description:
      'Validate a YAML/JSON test plan and split it into Gibwork bounties (one per device class and chunk of cases). Returns bounty list and total budget. Nothing is published.',
    inputSchema: {
      planPath: z.string().describe('Path to the test plan file'),
      environment: z.enum(['mock', 'stage', 'production']).default('stage').describe('mock runs fully offline with simulated testers'),
    },
  },
  async ({ planPath, environment }) => {
    try {
      const { run, summary, warnings } = await planRun(resolve(planPath), store, environment);
      const spend = publishSpend(run);
      checkBudgetCap(run, spend.cents, guard);
      return ok({
        ...summary,
        warnings,
        confirmCode: confirmCode(run, spend),
        next: `Show the user the budget (${summary.totalBudget} ${summary.symbol} plus Gibwork fees, on ${environment}) and ask them to approve it. Only after they say yes, call qa_publish with this confirmCode.`,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_preview_bounty',
  {
    title: 'Preview one bounty',
    description: 'Return the exact text testers will see for one batch, including the result template.',
    inputSchema: { batchId: z.string(), runId },
  },
  async ({ batchId, runId: id }) => {
    try {
      const run = await store.load(id);
      const b = run.batches.find((x) => x.id === batchId);
      if (!b) throw new Error(`No batch ${batchId}. Batches: ${run.batches.map((x) => x.id).join(', ')}`);
      return ok(`${b.title}\n\n${htmlToText(b.content)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_publish',
  {
    title: 'Publish and fund bounties',
    description:
      'Create and fund a Gibwork bounty per batch via the Gibwork SDK. Already published batches are skipped. Moves funds: requires the confirmCode for this exact amount, which a call without it returns along with the cost to show the user.',
    inputSchema: { confirmCode: confirmCodeArg, batchId: z.string().optional(), runId },
  },
  async ({ confirmCode: code, batchId, runId: id }) => {
    try {
      return ok(
        await store.withRun(id, async (run) => {
          if (batchId && !run.batches.some((b) => b.id === batchId)) throw new Error(`No batch ${batchId}. Batches: ${run.batches.map((x) => x.id).join(', ')}`);
          guardSpend(run, publishSpend(run, batchId), code, guard);
          return publishRun(run, createClient({ environment: run.environment, stateDir: store.dir }), store, { batchId });
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_status',
  {
    title: 'Run status',
    description: 'Per-bounty publish state, submission counts and how many testers have been paid.',
    inputSchema: { runId },
  },
  async ({ runId: id }) => {
    try {
      const run = await store.load(id);
      const s = summarize(run);
      return ok({
        runId: run.runId,
        environment: run.environment,
        budget: `${s.totalBudget} ${s.symbol}`,
        collectedAt: run.collectedAt ?? null,
        batches: run.batches.map((b) => {
          const subs = Object.values(run.submissions).filter((x) => x.batchId === b.id);
          return {
            id: b.id,
            taskId: b.taskId ?? null,
            state: b.ambiguous ? 'unresolved' : b.taskId ? 'live' : 'draft',
            submissions: subs.length,
            paid: subs.filter((x) => x.reviewStatus === 'approved').length,
            slots: run.plan.reward.testersPerBatch,
          };
        }),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_collect',
  {
    title: 'Collect tester results',
    description: 'Fetch submissions for every published bounty and parse each tester result block (valid, incomplete or invalid).',
    inputSchema: { runId },
  },
  async ({ runId: id }) => {
    try {
      return ok(await store.withRun(id, (run) => collectRun(run, createClient({ environment: run.environment, stateDir: store.dir }), store)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_triage',
  {
    title: 'Pay or reject submissions',
    description:
      'Plan payouts for complete, evidenced work (first come first served up to the tester slots) and rejections with actionable reasons. Payees and amounts come from the plan and cannot be chosen. Dry run unless apply=true with the confirmCode from the dry run.',
    inputSchema: { apply: z.boolean().default(false), confirmCode: confirmCodeArg, runId },
  },
  async ({ apply, confirmCode: code, runId: id }) => {
    try {
      return await store.withRun(id, async (run) => {
        const actions = planTriage(run);
        const spend = paySpend(actions);
        if (!apply) {
          const sym = run.plan.reward.symbol;
          const total = fromCents(spend.cents);
          return ok({
            dryRun: true,
            actions,
            ...(spend.targets.length
              ? {
                  payTotal: `${total} ${sym}`,
                  confirmCode: confirmCode(run, spend),
                  next: `Show the user the payouts (${total} ${sym} in total) and rejections, and ask them to approve. Only after they say yes, call again with apply=true and this confirmCode.`,
                }
              : { next: 'Nothing to pay or reject.' }),
          });
        }
        guardSpend(run, spend, code, guard);
        return ok({ dryRun: false, actions: await applyTriage(run, createClient({ environment: run.environment, stateDir: store.dir }), store, actions) });
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'qa_report',
  {
    title: 'Release gate report',
    description: 'Aggregate results into a device × case matrix and a release verdict (PASS, FAIL, INCOMPLETE). Writes report.md, results.csv, junit.xml and summary.json.',
    inputSchema: { outDir: z.string().default('qa-report'), runId },
  },
  async ({ outDir, runId: id }) => {
    try {
      const run = await store.load(id);
      const { agg, files } = await reportRun(run, resolve(outDir), ['md', 'csv', 'junit', 'json']);
      return ok({
        gate: agg.gate,
        totals: agg.totals,
        notes: attentionNotes(agg),
        matrix: agg.cases.map((c) => ({ id: c.testCase.id, title: c.testCase.title, priority: c.testCase.priority, outcome: c.outcome, byDevice: Object.fromEntries(c.cells.map((x) => [x.deviceId, x.outcome])) })),
        files,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'review_precheck',
  {
    title: 'Check a bounty submission before sending it',
    description:
      "For participants: run a bounty's automated checks on a draft submission before submitting it. Read-only and free: nothing is submitted and no funds move. " +
      'Rules come from the bounty text when it was published with gibreview. Show the user every failed check and the summary, and suggest fixes for fixable ones.',
    inputSchema: {
      taskId: z.string().describe('Gibwork task id of the bounty'),
      submission: z.string().min(1).describe('The draft submission text, including the SUBMISSION block'),
      environment: z.enum(['stage', 'production', 'mock']).default('stage'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ taskId, submission, environment }) => {
    try {
      const { precheck } = await import('./review/precheck.js');
      const { mockFetch } = await import('./review/mockweb.js');
      const client = createClient({ environment, stateDir: stateRoot });
      const task = (await client.tasks.get(taskId)) as unknown as { title: string; content: string; deadline?: string | null };
      const ctx = environment === 'mock' ? { fetch: mockFetch } : { fetch: globalThis.fetch as unknown as typeof mockFetch, githubToken: process.env.GITHUB_TOKEN };
      return ok({ bounty: task.title, ...(await precheck({ content: task.content, deadline: task.deadline ?? null }, submission, ctx)) });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
