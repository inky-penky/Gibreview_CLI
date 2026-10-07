#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient } from './gibwork.js';
import { Store, type RunState } from './state.js';
import { htmlToText } from './content.js';
import { PlanError } from './plan.js';
import { applyTriage, collectRun, describeError, planRun, planTriage, publishRun, reportRun, summarize } from './engine.js';

if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * MCP server so a coding agent can run a human QA pass as part of shipping:
 * "run the checkout regression on real phones and tell me if v2.3.0 is safe to release".
 *
 * Money-moving tools (publish, triage apply) need confirm=true, and on Gibwork production they
 * also need BUGBASH_MCP_ALLOW_PRODUCTION=1 in the server's environment. An agent cannot opt itself in.
 */

const store = new Store(resolve(process.env.BUGBASH_DIR ?? '.bugbash'));
const allowProd = process.env.BUGBASH_MCP_ALLOW_PRODUCTION === '1';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof PlanError ? `${err.message}\n${err.issues.map((i) => `- ${i}`).join('\n')}` : describeError(err) }],
});

function guardSpend(run: RunState, confirm: boolean | undefined) {
  if (!confirm) throw new Error('This moves funds. Show the user the cost and call again with confirm=true once they agree.');
  if (run.environment === 'production' && !allowProd) {
    throw new Error('Run targets Gibwork production. The server operator must set BUGBASH_MCP_ALLOW_PRODUCTION=1 to allow agent payouts.');
  }
}

const server = new McpServer({ name: 'gibwork-bugbash', version: '0.1.0' });
const runId = z.string().optional().describe('Run id. Defaults to the most recent run.');

server.registerTool(
  'bugbash_generate_plan',
  {
    title: 'Draft a test plan from a URL',
    description:
      'Read a feature page and draft manual test cases as a YAML test plan marked draft: true. The user must review it and remove draft: true before bugbash_plan accepts it. Show the user the cases and any review notes.',
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
        next: 'Ask the user to review the file, resolve review notes and delete "draft: true", then call bugbash_plan.',
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'bugbash_plan',
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
      const { summary } = await planRun(resolve(planPath), store, environment);
      return ok({ ...summary, next: 'Show the budget to the user, then call bugbash_publish with confirm=true.' });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'bugbash_preview_bounty',
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
  'bugbash_publish',
  {
    title: 'Publish and fund bounties',
    description: 'Create and fund a Gibwork bounty per batch via the Gibwork SDK. Already published batches are skipped. Requires confirm=true.',
    inputSchema: { confirm: z.boolean().optional(), batchId: z.string().optional(), runId },
  },
  async ({ confirm, batchId, runId: id }) => {
    try {
      const run = await store.load(id);
      guardSpend(run, confirm);
      return ok(await publishRun(run, createClient({ environment: run.environment, stateDir: store.dir }), store, { batchId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'bugbash_status',
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
  'bugbash_collect',
  {
    title: 'Collect tester results',
    description: 'Fetch submissions for every published bounty and parse each tester result block (valid, incomplete or invalid).',
    inputSchema: { runId },
  },
  async ({ runId: id }) => {
    try {
      const run = await store.load(id);
      return ok(await collectRun(run, createClient({ environment: run.environment, stateDir: store.dir }), store));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'bugbash_triage',
  {
    title: 'Pay or reject submissions',
    description:
      'Plan payouts for complete, evidenced work (first come first served up to the tester slots) and rejections with actionable reasons. Dry run unless apply=true and confirm=true.',
    inputSchema: { apply: z.boolean().default(false), confirm: z.boolean().optional(), runId },
  },
  async ({ apply, confirm, runId: id }) => {
    try {
      const run = await store.load(id);
      const actions = planTriage(run);
      if (!apply) return ok({ dryRun: true, actions });
      guardSpend(run, confirm);
      return ok({ dryRun: false, actions: await applyTriage(run, createClient({ environment: run.environment, stateDir: store.dir }), store, actions) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'bugbash_report',
  {
    title: 'Release gate report',
    description: 'Aggregate results into a device × case matrix and a release verdict (PASS, FAIL, INCOMPLETE). Writes report.md, results.csv, junit.xml and summary.json.',
    inputSchema: { outDir: z.string().default('bugbash-report'), runId },
  },
  async ({ outDir, runId: id }) => {
    try {
      const run = await store.load(id);
      const { agg, files } = await reportRun(run, resolve(outDir), ['md', 'csv', 'junit', 'json']);
      return ok({
        gate: agg.gate,
        totals: agg.totals,
        matrix: agg.cases.map((c) => ({ id: c.testCase.id, title: c.testCase.title, priority: c.testCase.priority, outcome: c.outcome, byDevice: Object.fromEntries(c.cells.map((x) => [x.deviceId, x.outcome])) })),
        files,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
