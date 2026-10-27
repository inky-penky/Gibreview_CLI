#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { describeError } from '../engine.js';
import { createClient, loadEnvFiles, resolveEnvironment } from '../gibwork.js';
import { fromCents, PlanError, toCents } from '../plan.js';
import { Store } from '../state.js';
import { htmlToText } from '../template.js';
import { ACCESS_LABEL, briefText, loadBrief, minimumPayment, siteCategory, totalPayoutCents, WEBSITE_POOLS, websitePool, winnerSlots } from './brief.js';
import type { CheckContext } from './checks.js';
import { attachTask, collectReview, publishBrief, publishPreview, rankReview, type ReviewState } from './engine.js';
import { applyDecisions, closePreview, closeReview, decisionCode, planDecisions, recordDecisions, websiteChecklist, type ReviewAction } from './decide.js';
import { mockFetch } from './mockweb.js';
import { precheck } from './precheck.js';
import { scoreReview } from './score.js';
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
    console.log(`  pool ${state.task.pool} ${state.task.symbol}${state.task.minimum ? ` · minimum ${state.task.minimum} per approved submission` : ''}${state.task.deadline ? ` · deadline ${state.task.deadline}` : ''} · run ${state.runId}`);
    if (!state.task.walletCanPay) {
      console.log(c.yellow(`\n! This bounty belongs to a Gibwork account wallet, not the wallet in SOLANA_PRIVATE_KEY, so gibreview`));
      console.log(c.yellow(`  cannot pay, reject or refund on it. Bounties made on gibwork.com are paid from the account's own wallet.`));
      console.log(c.yellow(`  gibreview still reviews and ranks everything; "decide" gives you a checklist to do on gibwork.com.`));
    }
    const below = state.task.minimum ? brief.payout.amounts.filter((a) => Number(a) < Number(state.task.minimum)) : [];
    if (below.length) {
      console.log(c.red(`\n! ${below.join(', ')} ${state.task.symbol} in the brief's payout is below this bounty's minimum of ${state.task.minimum}.`));
      console.log(c.red(`  Gibwork cannot pay those places; decide will hold them. Change the payout in ${opts.brief} and attach again.`));
    }
    if (state.task.rules === 'missing') {
      console.log(c.yellow(`\n! The bounty text does not list the rules, so participants cannot pre-check against them.`));
      console.log(c.yellow(`  Edit the bounty and paste the output of "gibreview text ${opts.brief}", or share the brief with participants.`));
    } else if (state.task.rules === 'differ') {
      console.log(c.yellow(`\n! The rules in the bounty text differ from ${opts.brief}. Submissions are reviewed against the brief,`));
      console.log(c.yellow(`  but participants pre-check against the bounty. Make them the same with "gibreview text ${opts.brief}".`));
    }
    console.log(`\nNext ${c.bold('gibreview collect')}`);
  });

program
  .command('text')
  .description('write a brief as bounty text for "Create Bounty" on the Gibwork website, with what to pick on each tab')
  .argument('<brief>', 'brief file (.yaml or .json)')
  .option('--out <file>', 'description file (default: <brief name>.description.txt)')
  .option('--stdout', 'print only the description, e.g. to pipe into the clipboard ("| clip" on Windows)')
  .action(async (briefPath: string, opts: { out?: string; stdout?: boolean }) => {
    const brief = await loadBrief(briefPath);
    const text = briefText(brief);
    if (opts.stdout) return void process.stdout.write(text + '\n');

    // Only the description goes in the file, so the whole file can be pasted as it is.
    const out = opts.out ?? `${basename(briefPath).replace(/\.(ya?ml|json)$/i, '')}.description.txt`;
    await writeFile(out, text + '\n');
    const sym = brief.bounty?.symbol ?? 'USDC';
    const category = siteCategory(brief);
    const minimum = minimumPayment(brief);
    const pool = brief.bounty?.pool ?? fromCents(totalPayoutCents(brief));
    const access = brief.bounty?.access ?? 'everyone';
    const due = brief.bounty?.deadlineHours ? `due ${new Date(Date.now() + brief.bounty.deadlineHours * 3_600_000).toDateString()}` : 'pick a due date';

    console.log(`${c.green('✓')} Wrote the description to ${c.bold(out)}\n`);
    console.log(c.bold('On gibwork.com, Create Bounty:'));
    console.log(`  title        ${brief.name}`);
    console.log(`  category     ${category}`);
    console.log(`  options      ${ACCESS_LABEL[access]} · ${due}`);
    if (access === 'discord' && brief.bounty?.discord) console.log(c.dim(`               server ${brief.bounty.discord.guildName}${brief.bounty.discord.roleIds.length ? `, roles ${brief.bounty.discord.roleIds.join(', ')}` : ''}`));
    console.log(`  payment      Custom minimum $${minimum} ${c.dim('(each approved submission is paid at least this; the tiers are only suggestions)')}`);
    console.log(`  description  paste everything in ${out}`);
    console.log(c.bold('\nThen Continue to Payment:'));
    const tier = websitePool(toCents(pool));
    if (!tier) {
      console.log(c.red(`  The website offers bounty amounts up to $700 and your pool is ${pool} ${sym}.`));
      console.log(c.red(`  Lower bounty.pool and the payouts, or create it with "gibreview publish", which can fund any amount.`));
    } else {
      console.log(`  bounty amount  ${c.bold(`$${tier.amount}`)} ${c.dim(`unlocks ${tier.unlocks}`)}`);
      if (!tier.exact) {
        const left = fromCents(tier.amount * 100 - totalPayoutCents(brief));
        console.log(c.yellow(`                 The website has no $${pool}, only $${WEBSITE_POOLS.map((t) => t.amount).join(', $')}. With $${tier.amount}, ${left} ${sym} is left`));
        console.log(c.yellow(`                 after the payouts; "gibreview close" refunds it. Or set bounty.pool to $${tier.amount} and raise the payouts.`));
      }
    }
    console.log(`  pay with       Wallet: the Solana wallet Gibwork made for your account (deposit USDC to it first if it is short)`);
    console.log(`                 or Card. Any platform fee is shown before you pay.`);
    console.log(`  ${c.yellow('Authorize & Publish moves the money.')} Everything before it is safe to click through.`);
    if (access === 'link') console.log(c.dim(`\nOnly people with the bounty's link can take part, so share it with them.`));
    console.log(c.dim(`\nAfter publishing: gibreview attach <taskId> --brief ${briefPath}`));
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
    const slots = winnerSlots(state.brief, toCents(state.task.pool));
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
    console.log(c.dim(`\nNothing is paid at this step. Read the shortlisted work, then run "gibreview decide" to see who would be paid.`));
  });

const ACTION = { pay: c.green('PAY    '), 'request-changes': c.yellow('CHANGES'), reject: c.red('REJECT '), hold: c.dim('HOLD   ') };
const money = (cents: number, sym: string) => `${(cents / 100).toFixed(2)} ${sym}`;

function showActions(actions: ReviewAction[], sym: string) {
  for (const a of actions) {
    const what = a.action === 'pay' ? `${c.bold(`${a.amount} ${sym}`)}  ${a.message}` : c.dim(a.message);
    const done = a.outcome === 'done' ? c.green('  ✓') : a.outcome === 'error' ? c.red(`  ✗ ${a.error}`) : '';
    console.log(`  ${ACTION[a.action]} @${a.username.padEnd(15)} ${what}${done}`);
  }
}

program
  .command('decide')
  .description('who to pay, who to ask for a fix, who to reject (dry run unless --apply or --mark-done)')
  .option('--apply', 'pay winners through escrow, post fix requests and send rejections')
  .option('--mark-done', 'record the plan as done after you carried it out on the Gibwork website (sends nothing)')
  .option('--confirm <code>', 'the confirm code the dry run printed; it covers exactly that plan')
  .action(async (opts: { apply?: boolean; markDone?: boolean; confirm?: string }) => {
    await store().withRun(program.opts().run, async (state) => {
      if (!state.collectedAt) throw new Error('No submissions collected yet. Run "gibreview collect" first.');
      const plan = planDecisions(state);
      const sym = state.task.symbol;
      const code = decisionCode(state, plan);
      // A bounty made on gibwork.com belongs to the account's own wallet, so it can only be paid on the website.
      const byHand = state.task.walletCanPay === false;
      const acting = opts.confirm === code && Boolean(opts.markDone || (opts.apply && !byHand));
      const count = (k: ReviewAction['action']) => plan.actions.filter((a) => a.action === k).length;
      console.log(`${c.bold(state.brief.name)}  ${envBadge(state.environment)}  ${c.dim(`${state.brief.payout.rule}, pool ${state.task.pool} ${sym}`)}\n`);
      plan.notes.forEach((n) => console.log(`  ${c.yellow('!')} ${n}`));
      if (plan.notes.length) console.log('');
      showActions(acting ? [] : plan.actions, sym);
      if (!code) return console.log(`${plan.actions.length ? '\n' : ''}Nothing to do: every submission is decided, held or waiting for a fix.`);

      const pays = count('pay');
      const summary = `${c.bold(money(plan.payCents, sym))} to ${pays} winner${pays === 1 ? '' : 's'} · ${count('request-changes')} fix requests · ${count('reject')} rejections · ${count('hold')} held`;
      const leftCents = plan.poolCents - plan.paidCents - plan.payCents;
      const left = leftCents > 0 ? `${money(leftCents, sym)} of the pool left afterwards; "gibreview close" refunds it` : 'the whole pool is paid out';
      if (!acting) {
        console.log(`\n  ${summary}\n  ${c.dim(left)}`);
        process.exitCode = opts.apply || opts.markDone ? 1 : 0;
        if (opts.apply && byHand) {
          console.log(c.red('\n✗ Nothing was sent: this wallet cannot pay on this bounty.'));
        } else if (opts.apply || opts.markDone) {
          console.log(c.red(`\n✗ ${opts.confirm ? 'That confirm code is for a different plan: submissions or amounts changed since.' : 'This needs the confirm code.'} Nothing was ${opts.apply ? 'sent' : 'recorded'}.`));
        } else {
          console.log(c.dim('\nDry run. Nothing was paid, posted or rejected.'));
        }
        if (!byHand) return console.log(`To apply exactly this plan: ${c.bold(`gibreview decide --apply --confirm ${code}`)}`);
        console.log(`\nThis bounty was made on gibwork.com, so it belongs to the wallet Gibwork created for the creator's account,`);
        console.log(`and only that account can pay, reject or refund on it. Do these on gibwork.com, signed in as the creator:\n`);
        websiteChecklist(plan, sym).forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
        return console.log(`\nWhen they are all done: ${c.bold(`gibreview decide --mark-done --confirm ${code}`)}`);
      }

      if (opts.markDone) {
        await recordDecisions(state, store(), plan);
        showActions(plan.actions, sym);
        return console.log(`\n${c.green('✓')} Recorded as done on the website. Nothing was sent to Gibwork. ${c.dim(left)}`);
      }
      await applyDecisions(state, client(state.environment), store(), plan, log);
      showActions(plan.actions, sym);
      const failed = plan.actions.filter((a) => a.outcome === 'error').length;
      if (failed) {
        process.exitCode = 1;
        return console.log(c.red(`\n✗ ${failed} action${failed === 1 ? '' : 's'} failed. Fix the cause and run decide again; finished actions are not repeated.`));
      }
      console.log(`\n${c.green('✓')} Done. ${c.dim(left)}`);
    });
  });

program
  .command('close')
  .description('refund the part of the pool nobody won and close the bounty')
  .option('--confirm', 'actually refund and close')
  .option('--force', 'close even though winners in the current plan are unpaid')
  .action(async (opts: { confirm?: boolean; force?: boolean }) => {
    await store().withRun(program.opts().run, async (state) => {
      const sym = state.task.symbol;
      if (state.closed) return console.log(`Already closed on ${state.closed.at}${state.closed.refunded ? `, ${state.closed.refunded} ${sym} refunded` : ''}.`);
      const p = closePreview(state);
      console.log(`${c.bold(state.brief.name)}  ${envBadge(state.environment)}`);
      console.log(`  pool ${state.task.pool} ${sym} · paid ${p.paid} ${sym} · about ${c.bold(`${p.left} ${sym}`)} comes back, less any Gibwork refund fee`);
      if (p.undecided) console.log(c.dim(`  ${p.undecided} submission${p.undecided === 1 ? ' stays' : 's stay'} undecided (held or waiting for a fix)`));
      if (p.unpaidWinners.length && !opts.force) {
        process.exitCode = 1;
        console.log(c.red(`\n✗ ${p.unpaidWinners.map((a) => `@${a.username} (${a.amount} ${sym})`).join(', ')} would be paid by the current plan but ${p.unpaidWinners.length === 1 ? 'is' : 'are'} not yet.`));
        return console.log(`Run ${c.bold('gibreview decide')} first, or close anyway with ${c.bold('--force')} and they are never paid.`);
      }
      if (state.task.walletCanPay === false) {
        if (p.left === '0.00') return console.log('\nThe whole pool was paid out, so there is nothing to refund.');
        return console.log(`\nThis wallet cannot refund this bounty. Refund the remaining ${p.left} ${sym} on gibwork.com, signed in as the bounty's creator.`);
      }
      if (!opts.confirm) return console.log(`\nNothing refunded. Re-run with ${c.bold('--confirm')} to close the bounty.`);
      const closed = await closeReview(state, client(state.environment), store());
      console.log(`${c.green('✓')} Closed${closed.refunded ? `, ${closed.refunded} ${sym} refunded` : ''}  ${c.dim(`tx ${closed.txHash}`)}`);
    });
  });

program
  .command('check')
  .description('participants: check a draft against a bounty\'s rules before submitting (free, sends nothing)')
  .argument('<taskId>', 'Gibwork task id of the bounty')
  .argument('<file>', 'your draft submission, or - to read it from stdin')
  .option('--brief <file>', "the creator's brief, for bounties that do not list gibreview rules")
  .addOption(new Option('--mock', 'use the offline simulator'))
  .addOption(new Option('--prod', 'target Gibwork production (default is stage)'))
  .action(async (taskId: string, file: string, opts: { brief?: string; mock?: boolean; prod?: boolean }) => {
    const draft = file === '-' ? await readStdin() : await readFile(file, 'utf8').catch(() => Promise.reject(new Error(`Cannot read ${file}`)));
    const env = resolveEnvironment(opts);
    const task = (await client(env).tasks.get(taskId)) as unknown as { title: string; content: string; deadline?: string | null };
    const template = opts.brief ? (await loadBrief(opts.brief)).template : undefined;
    const res = await precheck({ content: task.content, deadline: task.deadline ?? null }, draft, checkContext(env), { template });
    console.log(`${c.bold(task.title)}  ${envBadge(env)}  ${c.dim(`rules from the ${res.rules}: ${res.fields.join(', ')}`)}\n`);
    const icon = { pass: c.green('✓'), warn: c.yellow('?'), fail: c.red('✗') };
    for (const ch of res.checks) console.log(`  ${icon[ch.status]} ${ch.id.padEnd(10)} ${ch.message}${ch.status === 'fail' && !ch.fixable ? c.red('  (cannot be fixed)') : ''}`);
    console.log(`\n${res.ready ? c.green('✓') : c.red('✗')} ${res.summary}`);
    res.limits.forEach((l) => console.log(c.dim(`  ${l}`)));
    if (!res.ready) process.exitCode = 1;
  });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

program
  .command('status')
  .description('show the review run')
  .action(async () => {
    const s = await store().load(program.opts().run);
    const subs = Object.values(s.submissions);
    console.log(`${c.bold(s.brief.name)}  ${envBadge(s.environment)}  run ${s.runId}`);
    console.log(`  task ${s.task.id ?? (s.task.ambiguous ? c.red(`unresolved (intent ${s.task.ambiguous.intentId})`) : 'not published')} · ${s.task.publishedBy} · pool ${s.task.pool} ${s.task.symbol}`);
    console.log(`  ${subs.length} submissions${s.collectedAt ? `, last collected ${s.collectedAt}` : ', not collected yet'}`);
    const paid = subs.filter((x) => x.decision?.action === 'pay');
    if (paid.length) console.log(`  paid ${paid.map((x) => `@${x.username} ${x.decision!.amount}`).join(', ')} ${s.task.symbol}`);
    if (s.closed) console.log(`  closed ${s.closed.at}${s.closed.refunded ? `, ${s.closed.refunded} ${s.task.symbol} refunded` : ''}`);
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

program
  .command('score')
  .description("AI rubric: score eligible submissions against the brief's criteria (needs ANTHROPIC_API_KEY)")
  .option('--model <id>', 'Claude model (default: GIBREVIEW_AI_MODEL or claude-sonnet-5-5)')
  .action(async (opts: { model?: string }) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to score submissions. Scoring is optional; rank works without it.');
    const res = await store().withRun(program.opts().run, (state) =>
      scoreReview(state, store(), checkContext(state.environment), { apiKey, model: opts.model, log }),
    );
    console.log(`${c.green('✓')} ${res.scored.length} scored${res.kept ? `, ${res.kept} unchanged since their last score` : ''}`);
    for (const f of res.failed) console.log(c.red(`  ✗ @${f.username}: ${f.error}`));
    if (res.failed.length) {
      process.exitCode = 1;
      console.log(c.dim('Ranking ignores AI scores until every eligible submission has one. Run score again.'));
    }
    console.log(c.dim('\nSubmissions and their linked pages were sent to Anthropic for scoring. Scores are advisory.'));
    console.log(`Next ${c.bold('gibreview rank')}`);
  });

// The QA preset (test plan -> tester bounties -> release-gate report) is its own command set.
program.command('qa', 'crowdsourced manual QA: test plan to tester bounties to a release-gate report (gibreview qa --help)', {
  executableFile: join(here, '..', 'cli.js'),
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
