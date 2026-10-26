#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { createClient, loadEnvFiles, resolveEnvironment } from './gibwork.js';
import { Store, type RunState } from './state.js';
import { PlanError } from './plan.js';
import { htmlToText } from './content.js';
import { applyTriage, collectRun, describeError, gateExitCode, planRun, planTriage, publishRun, refundRun, reportRun, summarize } from './engine.js';
import { attentionNotes, type ReportFormat } from './report.js';

loadEnvFiles();

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
const log = (m: string) => console.log(c.dim(`  ${m}`));
const here = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name('bugbash')
  .description('Crowdsourced manual QA from your terminal, paid through Gibwork bounties.')
  .version('0.1.0')
  .option('--dir <path>', 'where run state lives', '.bugbash')
  .option('--run <id>', 'run id (defaults to the most recent run)');

const store = () => new Store(resolve(program.opts().dir));
const load = async (): Promise<RunState> => store().load(program.opts().run);
/** Commands that publish, pay or refund hold the run's lock and work on a copy loaded inside it. */
const locked =
  <A extends unknown[]>(fn: (run: RunState, ...args: A) => Promise<unknown>) =>
  (...args: A): Promise<void> =>
    store().withRun(program.opts().run, async (run) => {
      await fn(run, ...args);
    });
const client = (run: RunState) => createClient({ environment: run.environment, stateDir: store().dir });
const envBadge = (env: string) => (env === 'production' ? c.red(c.bold('PRODUCTION')) : env === 'mock' ? c.cyan('mock') : c.yellow('stage'));

program
  .command('init')
  .description('write a sample test plan to start from')
  .argument('[file]', 'destination', 'testplan.yaml')
  .action(async (file: string) => {
    if (existsSync(file)) throw new Error(`${file} already exists`);
    await copyFile(join(here, '..', 'examples', 'checkout-regression.yaml'), file);
    console.log(`${c.green('✓')} Wrote ${file}. Edit the cases and devices, then run ${c.bold(`bugbash plan ${file}`)}`);
  });

program
  .command('generate')
  .description('draft a test plan from a feature URL (rule-based, or AI when ANTHROPIC_API_KEY is set)')
  .argument('<url>', 'page of the feature to test')
  .option('-o, --out <file>', 'where to write the draft plan', 'testplan.yaml')
  .option('--describe <text>', 'what the feature should do, in plain words (used by the AI writer)')
  .option('--name <name>', 'plan name')
  .option('--max-cases <n>', 'cap on generated cases', (v) => parseInt(v, 10), 12)
  .addOption(new Option('--render <mode>', 'how to read the page').choices(['auto', 'browser', 'fetch']).default('auto'))
  .option('--cookies <value>', 'cookie header ("a=1; b=2") or a Playwright storage-state JSON file, for pages behind a login')
  .option('--html <file>', 'read a saved HTML file instead of fetching the URL')
  .option('--ai', 'require the AI writer')
  .option('--no-ai', 'never use the AI writer')
  .option('--force', 'overwrite the output file')
  .action(async (url: string, opts: { out: string; describe?: string; name?: string; maxCases: number; render: 'auto' | 'browser' | 'fetch'; cookies?: string; html?: string; ai?: boolean; force?: boolean }) => {
    const { generatePlan, writePlanFile } = await import('./generate/index.js');
    const ai = opts.ai === true && process.argv.includes('--ai') ? 'on' : opts.ai === false ? 'off' : 'auto';
    const res = await generatePlan({ url, htmlFile: opts.html, render: opts.render, cookies: opts.cookies, describe: opts.describe, name: opts.name, maxCases: opts.maxCases, ai, log });
    await writePlanFile(opts.out, res.yaml, opts.force);
    const p = res.page;
    console.log(`${c.bold('Read')} ${p.title} ${c.dim(`(via ${p.renderedWith})`)}`);
    console.log(c.dim(`  ${p.forms.length} forms, ${p.forms.reduce((n, f) => n + f.fields.length, 0)} fields, ${p.actions.length} actions, ${p.links.length} nav links`));
    console.log(`\n${c.bold(`${res.plan.cases.length} draft cases`)} ${c.dim(res.source === 'ai' ? 'by the AI writer' : 'by the rule-based writer')}\n`);
    for (const tc of res.plan.cases) {
      const pri = tc.priority === 'high' ? c.red('high  ') : tc.priority === 'medium' ? c.yellow('medium') : c.dim('low   ');
      console.log(`  ${tc.id}  ${pri}  ${tc.title}${tc.reviewNote ? c.cyan('  • needs review') : ''}`);
    }
    res.warnings.forEach((w) => console.log(c.yellow(`\n! ${w}`)));
    console.log(`\n${c.green('✓')} Wrote ${opts.out} as a draft. Review it, delete ${c.bold('draft: true')}, then run ${c.bold(`bugbash plan ${opts.out}`)}`);
  });

program
  .command('import')
  .description('turn a CSV/TSV of test cases (Excel, Google Sheets, TestRail, Zephyr, Xray…) into a test plan')
  .argument('<csv>', 'cases file')
  .requiredOption('--url <url>', 'build or staging URL testers should open')
  .option('-o, --out <file>', 'where to write the plan', 'testplan.yaml')
  .option('--name <name>', 'plan name (defaults to the file name)')
  .option('--release <version>', 'release being tested')
  .option('--per-tester <amount>', 'reward per accepted tester', '2.00')
  .option('--testers <n>', 'testers per bounty', (v) => parseInt(v, 10), 2)
  .option('--link', 'reference the CSV with casesFile instead of copying the cases in')
  .option('--force', 'overwrite the output file')
  .action(async (csvPath: string, opts: { url: string; out: string; name?: string; release?: string; perTester: string; testers: number; link?: boolean; force?: boolean }) => {
    const { importCsvPlan } = await import('./importplan.js');
    const { writePlanFile } = await import('./generate/index.js');
    const res = await importCsvPlan({ csvPath, outPath: opts.out, url: opts.url, name: opts.name, release: opts.release, perTester: opts.perTester, testersPerBatch: opts.testers, link: opts.link });
    await writePlanFile(opts.out, res.yaml, opts.force);
    const delim = { ',': 'comma', ';': 'semicolon', '\t': 'tab' }[res.csv.delimiter] ?? res.csv.delimiter;
    console.log(`${c.bold('Read')} ${csvPath} ${c.dim(`(${delim} separated)`)}`);
    console.log(c.dim('  Column mapping'));
    for (const [field, header] of Object.entries(res.csv.columns)) console.log(c.dim(`    ${field.padEnd(14)} ← ${header ?? '(not found)'}`));
    if (res.csv.ignoredColumns.length) console.log(c.dim(`  Ignored columns ${res.csv.ignoredColumns.join(', ')}`));
    const by = (p: string) => res.plan.cases.filter((x) => x.priority === p).length;
    console.log(`\n${c.bold(`${res.plan.cases.length} cases`)} imported, ${by('high')} high, ${by('medium')} medium, ${by('low')} low`);
    for (const tc of res.plan.cases.slice(0, 15)) console.log(`  ${tc.id.padEnd(10)} ${tc.priority.padEnd(6)}  ${tc.title.slice(0, 60)}  ${c.dim(`${tc.steps.length} step${tc.steps.length === 1 ? "" : "s"}${tc.devices ? ` · ${tc.devices.join(', ')}` : ''}`)}`);
    if (res.plan.cases.length > 15) console.log(c.dim(`  … and ${res.plan.cases.length - 15} more`));
    res.csv.warnings.forEach((w) => console.log(c.yellow(`! ${w}`)));
    console.log(`\n${c.green('✓')} Wrote ${opts.out}. Check it, then run ${c.bold(`bugbash plan ${opts.out}`)}`);
  });

program
  .command('plan')
  .description('validate a test plan, split it into bounties and preview cost (no money moves)')
  .argument('<file>', 'test plan (.yaml or .json)')
  .addOption(new Option('--mock', 'use the offline simulator instead of Gibwork'))
  .addOption(new Option('--prod', 'target Gibwork production (default is stage)'))
  .option('--show <batchId>', 'print the full bounty text for one batch')
  .action(async (file: string, opts: { mock?: boolean; prod?: boolean; show?: string }) => {
    const env = resolveEnvironment(opts);
    const { run, summary, warnings } = await planRun(file, store(), env);
    warnings.forEach((w) => console.log(c.yellow(`! ${w}`)));
    console.log(`${c.bold('Run')} ${summary.runId}  ${envBadge(env)}`);
    console.log(`${run.plan.cases.length} cases × ${run.plan.devices.length} device classes → ${c.bold(String(summary.batches.length))} bounties\n`);
    for (const b of summary.batches) console.log(`  ${c.cyan(b.id.padEnd(20))} ${String(b.cases).padStart(2)} cases  pool ${b.pool} ${summary.symbol}  ${c.dim(b.title)}`);
    console.log(`\nBudget ${c.bold(`${summary.totalBudget} ${summary.symbol}`)} (${run.plan.reward.perTester} per tester × ${run.plan.reward.testersPerBatch} testers × ${summary.batches.length} bounties), plus Gibwork platform fees`);
    if (opts.show) {
      const b = run.batches.find((x) => x.id === opts.show);
      if (!b) throw new Error(`No batch "${opts.show}"`);
      console.log(`\n${c.bold(b.title)}\n${'─'.repeat(60)}\n${htmlToText(b.content)}\n`);
    }
    console.log(`\nNext ${c.bold('bugbash publish --confirm')}`);
  });

program
  .command('publish')
  .description('fund and publish each batch as a Gibwork bounty')
  .option('--confirm', 'actually create and fund the bounties')
  .option('--batch <id>', 'publish only this batch')
  .action(locked(async (run, opts: { confirm?: boolean; batch?: string }) => {
    const s = summarize(run);
    const pending = run.batches.filter((b) => !b.taskId && (!opts.batch || b.id === opts.batch));
    if (!pending.length) return console.log('Every batch is already published.');
    if (!opts.confirm) {
      console.log(`Would publish ${pending.length} bounties on ${envBadge(run.environment)} for ${s.batches[0].pool} ${s.symbol} each.`);
      console.log(`Re-run with ${c.bold('--confirm')} to sign and fund them.`);
      return;
    }
    const res = await publishRun(run, client(run), store(), { batchId: opts.batch, log });
    for (const p of res.published) console.log(`${c.green('✓')} ${p.batchId.padEnd(20)} task ${p.taskId}${p.txHash ? c.dim(`  tx ${p.txHash}`) : ''}`);
    for (const f of res.failed) console.log(`${c.red('✗')} ${f.batchId.padEnd(20)} ${f.error}`);
    if (res.skipped.length) console.log(c.dim(`  already published ${res.skipped.join(', ')}`));
    if (res.stoppedEarly) console.log(c.yellow('Stopped early. Rerun publish later; published batches are skipped.'));
    if (res.failed.length) process.exitCode = 1;
  }));

program
  .command('status')
  .description('show bounties and collected submissions for the run')
  .action(async () => {
    const run = await load();
    console.log(`${c.bold('Run')} ${run.runId}  ${envBadge(run.environment)}  ${c.dim(run.collectedAt ? `last collected ${run.collectedAt}` : 'not collected yet')}`);
    for (const b of run.batches) {
      const subs = Object.values(run.submissions).filter((s) => s.batchId === b.id);
      const approved = subs.filter((s) => s.reviewStatus === 'approved').length;
      const state = b.ambiguous ? c.red('unresolved') : b.taskId ? c.green('live') : c.dim('draft');
      console.log(`  ${b.id.padEnd(20)} ${state.padEnd(tty ? 19 : 10)} ${String(subs.length).padStart(2)} submissions  ${approved}/${run.plan.reward.testersPerBatch} paid  ${c.dim(b.taskId ?? '')}`);
    }
  });

program
  .command('collect')
  .description('pull submissions from Gibwork and parse tester results')
  .action(locked(async (run) => {
    const res = await collectRun(run, client(run), store(), log);
    console.log(`${c.green('✓')} ${res.fetched} submissions fetched, ${res.newSubmissions} new`);
    for (const [id, b] of Object.entries(res.byBatch)) {
      console.log(`  ${id.padEnd(20)} ${c.green(`${b.valid} valid`)}  ${c.yellow(`${b.incomplete} incomplete`)}  ${c.red(`${b.invalid} invalid`)}`);
    }
    console.log(`\nNext ${c.bold('bugbash triage')}`);
  }));

program
  .command('triage')
  .description('decide which submissions to pay or reject (dry run unless --apply)')
  .option('--apply', 'execute approvals (pays testers) and rejections on Gibwork')
  .action(locked(async (run, opts: { apply?: boolean }) => {
    const actions = planTriage(run);
    if (!actions.length) return console.log('Nothing to triage. Run collect first, or everything is already reviewed.');
    const icon = { approve: c.green('PAY   '), reject: c.red('REJECT'), hold: c.yellow('HOLD  ') };
    const show = () =>
      actions.forEach((a) => {
        const suffix = a.outcome === 'error' ? c.red(`  ✗ ${a.error}`) : a.outcome === 'done' ? c.green('  ✓') : '';
        console.log(`  ${icon[a.action]} @${a.username.padEnd(14)} ${a.batchId.padEnd(18)} ${a.amount ? `${a.amount} ${run.plan.reward.symbol}  ` : ''}${c.dim(a.reason)}${suffix}`);
      });
    if (!opts.apply) {
      show();
      const pay = actions.filter((a) => a.action === 'approve').length;
      console.log(`\nDry run. ${pay} payouts and ${actions.filter((a) => a.action === 'reject').length} rejections planned. Re-run with ${c.bold('--apply')} to execute.`);
      return;
    }
    await applyTriage(run, client(run), store(), actions, log);
    show();
    if (actions.some((a) => a.outcome === 'error')) process.exitCode = 1;
  }));

program
  .command('report')
  .description('write the QA report and exit with the release gate result (0 pass, 1 fail, 2 incomplete)')
  .option('--out <dir>', 'output directory', 'bugbash-report')
  .option('--format <list>', 'comma-separated: md,csv,junit,json', 'md,csv,junit,json')
  .option('--no-gate', 'always exit 0')
  .action(async (opts: { out: string; format: string; gate: boolean }) => {
    const run = await load();
    const formats = opts.format.split(',').map((f) => f.trim()) as ReportFormat[];
    const { agg, files } = await reportRun(run, opts.out, formats);
    const colour = { PASS: c.green, FAIL: c.red, INCOMPLETE: c.yellow }[agg.gate.verdict];
    console.log(`${c.bold('Release gate')} ${colour(c.bold(agg.gate.verdict))}`);
    agg.gate.reasons.forEach((r) => console.log(`  • ${r}`));
    console.log('');
    for (const tc of agg.cases) {
      const cells = tc.cells.map((x) => `${x.deviceId}:${x.outcome}`).join('  ');
      const col = tc.outcome === 'PASS' ? c.green : tc.outcome === 'NOT_RUN' ? c.dim : tc.outcome === 'BLOCKED' ? c.yellow : c.red;
      console.log(`  ${col(tc.outcome.padEnd(9))} ${tc.testCase.id.padEnd(8)} ${tc.testCase.title.slice(0, 40).padEnd(40)} ${c.dim(cells)}`);
    }
    console.log(`\nPaid ${agg.totals.paid} ${run.plan.reward.symbol} to ${agg.totals.approved} testers`);
    attentionNotes(agg).forEach((n) => console.log(c.yellow(`! ${n}`)));
    files.forEach((f) => console.log(`${c.green('✓')} ${f}`));
    if (opts.gate) process.exitCode = gateExitCode(agg);
  });

program
  .command('refund')
  .description('close the run and refund unspent escrow from every bounty')
  .option('--confirm', 'actually refund')
  .action(locked(async (run, opts: { confirm?: boolean }) => {
    const live = run.batches.filter((b) => b.taskId && !b.refundedAt);
    if (!opts.confirm) return console.log(`Would refund ${live.length} bounties on ${envBadge(run.environment)}. Re-run with --confirm.`);
    for (const r of await refundRun(run, client(run), store(), log)) console.log(`${r.ok ? c.green('✓') : c.red('✗')} ${r.batchId.padEnd(20)} ${r.detail}`);
  }));

program
  .command('doctor')
  .description('check Node, wallet key and Gibwork connectivity with a free, read-only discovery call')
  .addOption(new Option('--prod', 'check Gibwork production instead of stage'))
  .action(async (opts: { prod?: boolean }) => {
    const env = resolveEnvironment({ prod: opts.prod });
    const major = Number(process.versions.node.split('.')[0]);
    console.log(`${major >= 22 ? c.green('✓') : c.red('✗')} Node ${process.versions.node} (needs 22+)`);
    if (!process.env.SOLANA_PRIVATE_KEY) {
      console.log(`${c.red('✗')} SOLANA_PRIVATE_KEY not set. Copy .env.example to .env, or use --mock.`);
      process.exitCode = 1;
      return;
    }
    const { keypairFromPrivateKey } = await import('@gibwork/sdk/node');
    const wallet = keypairFromPrivateKey(process.env.SOLANA_PRIVATE_KEY).publicKey.toBase58();
    console.log(`${c.green('✓')} Wallet ${wallet}`);
    const { createGibworkClient } = await import('@gibwork/sdk/node');
    const g = createGibworkClient({ privateKey: process.env.SOLANA_PRIVATE_KEY, production: env === 'production', timeoutMs: 15_000 });
    const page = await g.tasks.listAvailable({ page: 1, limit: 3 });
    console.log(`${c.green('✓')} Gibwork ${envBadge(env)} reachable, ${page.total} open bounties visible`);
    const mine = await g.tasks.list({ page: 1, limit: 1 });
    console.log(`${c.green('✓')} Wallet auth works, ${mine.total} bounties created by this wallet`);
  });

program
  .command('show')
  .description('print one submission as the tester sent it, plus how it was parsed')
  .argument('<submissionId>', 'id or unique prefix')
  .action(async (id: string) => {
    const run = await load();
    const matches = Object.values(run.submissions).filter((s) => s.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? 'Prefix is ambiguous' : 'No such submission');
    const s = matches[0];
    console.log(`${c.bold(`@${s.username}`)} on ${s.batchId} (${s.parsed.verdict}, ${s.reviewStatus})\n${htmlToText(s.content)}\n`);
    console.log(JSON.stringify(s.parsed, null, 2));
  });

program.parseAsync().catch(async (err) => {
  if (err instanceof PlanError) {
    console.error(c.red(`✗ ${err.message}`));
    err.issues.forEach((i) => console.error(`  - ${i}`));
  } else {
    console.error(c.red(`✗ ${describeError(err)}`));
  }
  process.exitCode = 1;
});
