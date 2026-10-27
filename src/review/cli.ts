#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { describeError } from '../engine.js';
import { createClient, loadEnvFiles, resolveEnvironment } from '../gibwork.js';
import { PlanError } from '../plan.js';
import { Store } from '../state.js';
import { htmlToText } from '../template.js';
import { loadBrief, winnerSlots } from './brief.js';
import type { CheckContext } from './checks.js';
import { attachTask, collectReview, publishBrief, publishPreview, rankReview, type ReviewState } from './engine.js';
import { mockFetch } from './mockweb.js';
import { writeShortlist } from './report.js';

loadEnvFiles();

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
const log = (m: string) => console.log(c.dim(`  ${m}`));
const here = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name('gibreview')
  .description('Review Gibwork bounty submissions: automated checks, a ranked shortlist and a reason for every decision.')
  .version('0.1.0')
  .option('--dir <path>', 'where review state lives', '.gibreview')
  .option('--run <id>', 'review run id (defaults to the most recent)');

const store = () => new Store<ReviewState>(resolve(program.opts().dir), 'Start one with "gibreview attach <taskId> --brief <file>" or "gibreview publish <brief>".');
const client = (env: ReviewState['environment']) => createClient({ environment: env, stateDir: store().dir });
const checkContext = (env: ReviewState['environment']): CheckContext =>
  env === 'mock' ? { fetch: mockFetch } : { fetch: globalThis.fetch as unknown as CheckContext['fetch'], githubToken: process.env.GITHUB_TOKEN };
const envBadge = (env: string) => (env === 'production' ? c.red(c.bold('PRODUCTION')) : env === 'mock' ? c.cyan('mock') : c.yellow('stage'));
const VERDICT = { eligible: c.green('eligible     '), 'needs-changes': c.yellow('needs changes'), disqualified: c.red('disqualified '), invalid: c.dim('invalid      ') };

program
  .command('init')
  .description('write an example brief to start from')
  .argument('[file]', 'destination', 'brief.yaml')
  .addOption(new Option('--preset <preset>', 'kind of bounty').choices(['content', 'dev']).default('content'))
  .action(async (file: string, opts: { preset: 'content' | 'dev' }) => {
    if (existsSync(file)) throw new Error(`${file} already exists`);
    await copyFile(join(here, '..', '..', 'examples', 'review', `${opts.preset}-brief.yaml`), file);
    console.log(`${c.green('✓')} Wrote ${file}. Edit it, then ${c.bold(`gibreview attach <taskId> --brief ${file}`)} or ${c.bold(`gibreview publish ${file}`)}`);
  });

program
  .command('publish')
  .description('create and fund a new bounty from a brief, through Gibwork escrow')
  .argument('<brief>', 'brief file (.yaml or .json)')
  .addOption(new Option('--mock', 'use the offline simulator'))
  .addOption(new Option('--prod', 'target Gibwork production (default is stage)'))
  .option('--confirm', 'actually create and fund the bounty')
  .action(async (briefPath: string, opts: { mock?: boolean; prod?: boolean; confirm?: boolean }) => {
    const brief = await loadBrief(briefPath);
    const env = resolveEnvironment(opts);
    const p = publishPreview(brief);
    console.log(`${c.bold(brief.name)}  ${envBadge(env)}`);
    console.log(`  pool ${c.bold(`${p.pool} ${p.symbol}`)} into escrow, plus Gibwork fees · pays at most ${p.maxPayout} ${p.symbol} (${brief.payout!.rule}, ${brief.payout!.amounts.join(' / ')})`);
    console.log(`  ${p.deadline ? `deadline ${p.deadline}` : 'no deadline'} · ${brief.template.length} template fields · ${brief.template.reduce((n, f) => n + f.checks.length, 0)} checks`);
    if (!opts.confirm) return console.log(`\nNothing published. Re-run with ${c.bold('--confirm')} to sign and fund it.`);
    const state = await publishBrief(brief, resolve(briefPath), env, client(env), store());
    console.log(`${c.green('✓')} Published task ${state.task.id}${state.task.txHash ? c.dim(`  tx ${state.task.txHash}`) : ''}`);
    console.log(`  run ${state.runId}. When submissions arrive: ${c.bold('gibreview collect')}`);
  });

program
  .command('attach')
  .description('review an existing Gibwork bounty, for example one created on the website (read-only)')
  .argument('<taskId>', 'Gibwork task id')
  .requiredOption('--brief <file>', 'brief describing the template and checks to apply')
  .addOption(new Option('--mock', 'use the offline simulator'))
  .addOption(new Option('--prod', 'target Gibwork production (default is stage)'))
  .action(async (taskId: string, opts: { brief: string; mock?: boolean; prod?: boolean }) => {
    const brief = await loadBrief(opts.brief);
    const env = resolveEnvironment(opts);
    const state = await attachTask(taskId, brief, resolve(opts.brief), env, client(env), store());
    console.log(`${c.green('✓')} Attached ${c.bold(state.task.title)}  ${envBadge(env)}`);
    console.log(`  pool ${state.task.pool} ${state.task.symbol}${state.task.deadline ? ` · deadline ${state.task.deadline}` : ''} · run ${state.runId}`);
    console.log(`\nNext ${c.bold('gibreview collect')}`);
  });

program
  .command('collect')
  .description('fetch every submission and run the checks (no money moves)')
  .option('--recheck', 'run every check again, for example after participants fixed links')
  .action(async (opts: { recheck?: boolean }) => {
    const res = await store().withRun(program.opts().run, (state) =>
      collectReview(state, client(state.environment), store(), checkContext(state.environment), { recheck: opts.recheck, log }),
    );
    const v = res.byVerdict;
    console.log(`${c.green('✓')} ${res.fetched} submissions, ${res.newSubmissions} new`);
    console.log(`  ${c.green(`${v.eligible} eligible`)}  ${c.yellow(`${v['needs-changes']} need changes`)}  ${c.red(`${v.disqualified} disqualified`)}  ${c.dim(`${v.invalid} invalid`)}`);
    console.log(`\nNext ${c.bold('gibreview rank')}`);
  });

program
  .command('rank')
  .description('print the ranked shortlist and write review.md and review.json')
  .option('--out <dir>', 'output directory', 'review-report')
  .action(async (opts: { out: string }) => {
    const state = await store().load(program.opts().run);
    const ranked = rankReview(state);
    const slots = winnerSlots(state.brief);
    console.log(`${c.bold(state.brief.name)}  ${envBadge(state.environment)}  ${c.dim(`shortlist of ${slots}`)}\n`);
    for (const r of ranked) {
      const s = r.submission;
      const mark = r.shortlisted ? c.green('★') : ' ';
      const place = r.place ? `#${r.place}`.padEnd(3) : ' – ';
      console.log(`  ${mark} ${place} ${VERDICT[s.verdict]}  @${s.username.padEnd(15)} ${c.dim(r.reason)}`);
      for (const w of r.warnings) console.log(c.dim(`                                   ? ${w}`));
    }
    const files = await writeShortlist(state, ranked, opts.out);
    console.log('');
    files.forEach((f) => console.log(`${c.green('✓')} ${f}`));
    console.log(c.dim('\nNothing is paid at this step. Paying winners comes with "gibreview decide" (next milestone).'));
  });

program
  .command('status')
  .description('show the review run')
  .action(async () => {
    const s = await store().load(program.opts().run);
    const subs = Object.values(s.submissions);
    console.log(`${c.bold(s.brief.name)}  ${envBadge(s.environment)}  run ${s.runId}`);
    console.log(`  task ${s.task.id ?? (s.task.ambiguous ? c.red(`unresolved (intent ${s.task.ambiguous.intentId})`) : 'not published')} · ${s.task.publishedBy} · pool ${s.task.pool} ${s.task.symbol}`);
    console.log(`  ${subs.length} submissions${s.collectedAt ? `, last collected ${s.collectedAt}` : ', not collected yet'}`);
  });

program
  .command('show')
  .description('one submission as sent, with every check result')
  .argument('<submissionId>', 'id or unique prefix, or @username')
  .action(async (id: string) => {
    const state = await store().load(program.opts().run);
    const subs = Object.values(state.submissions);
    const matches = id.startsWith('@') ? subs.filter((s) => s.username === id.slice(1)) : subs.filter((s) => s.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? 'More than one match, use the submission id' : 'No such submission');
    const s = matches[0];
    console.log(`${c.bold(`@${s.username}`)}  ${VERDICT[s.verdict]}  ${c.dim(`${s.id} · ${s.createdAt} · Gibwork ${s.remoteStatus}`)}\n`);
    console.log(htmlToText(s.content), '\n');
    const icon = { pass: c.green('✓'), warn: c.yellow('?'), fail: c.red('✗') };
    for (const ch of s.checks) console.log(`  ${icon[ch.status]} ${ch.id.padEnd(10)} ${ch.message}${ch.status === 'fail' && !ch.fixable ? c.red('  (disqualifies)') : ''}`);
  });

program.parseAsync().catch((err) => {
  if (err instanceof PlanError) {
    console.error(c.red(`✗ ${err.message}`));
    err.issues.forEach((i) => console.error(`  - ${i}`));
  } else {
    console.error(c.red(`✗ ${describeError(err)}`));
  }
  process.exitCode = 1;
});
