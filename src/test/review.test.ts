import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanError } from '../plan.js';
import { Store } from '../state.js';
import { createClient } from '../gibwork.js';
import { parseTemplate, renderTemplate } from '../template.js';
import { briefContent, briefTemplate, loadBrief, validateBrief, winnerSlots } from '../review/brief.js';
import { checkFields, deadlineCheck, findDuplicates, similarity, type CheckContext, type FetchLike } from '../review/checks.js';
import { attachTask, collectReview, publishBrief, rankReview, verdictOf, type ReviewState } from '../review/engine.js';
import { mockFetch } from '../review/mockweb.js';
import { htmlToText } from '../template.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'review');
const base = { name: 'Guide', description: 'Write a guide to the API.', payout: { rule: 'one-winner', amounts: ['10'] } };

// ---------- brief ----------

test('presets fill in the template, and examples are valid briefs', async () => {
  const b = validateBrief({ ...base, preset: 'content' });
  assert.deepEqual(b.template.map((f) => [f.id, f.type]), [['link', 'url'], ['summary', 'text']]);
  assert.equal(b.review.duplicates, 0.85);
  assert.equal((await loadBrief(join(examples, 'content-brief.yaml'))).payout!.amounts.length, 3);
  assert.equal(winnerSlots(await loadBrief(join(examples, 'dev-brief.yaml'))), 1);
});

test('brief validation explains what is wrong', () => {
  const issues = (raw: unknown) => {
    try {
      validateBrief(raw);
      return [];
    } catch (e) {
      assert.ok(e instanceof PlanError);
      return e.issues.join('\n');
    }
  };
  assert.match(String(issues({ ...base })), /custom brief needs a template/);
  assert.match(String(issues({ ...base, template: [{ id: 'notes', label: 'Notes', type: 'text', checks: ['reachable'] }] })), /needs a url field/);
  assert.match(String(issues({ ...base, preset: 'content', payout: undefined })), /payout is required: say whether this bounty pays one-winner, multiple-winners, pool/);
  assert.match(String(issues({ ...base, preset: 'content', payout: { amounts: ['5'] } })), /payout.rule must be one of/);
  assert.match(String(issues({ ...base, preset: 'content', payout: { rule: 'one-winner', amounts: ['5', '3'] } })), /use multiple-winners/);
  assert.match(String(issues({ ...base, preset: 'content', bounty: { pool: '10' }, payout: { rule: 'multiple-winners', amounts: ['8', '5'] } })), /more than the pool/);
  assert.match(String(issues({ ...base, preset: 'content', payout: { rule: 'pool', amounts: ['5', '3'] } })), /same amount/);
  assert.match(String(issues({ ...base, preset: 'content', payout: { rule: 'one-winner', amounts: ['5'], maxWinners: 3 } })), /maxWinners only applies to pool/);
  assert.match(String(issues({ ...base, preset: 'content', bounty: { pool: '4' }, payout: { rule: 'pool', amounts: ['5'] } })), /cannot cover one payment/);
  assert.match(String(issues({ ...base, preset: 'content', payout: { rule: 'multiple-winners', amounts: ['5', '0'] } })), /more than 0/);
});

test('a pool payout pays as many submissions as the pool covers, unless capped', () => {
  const b = validateBrief({ ...base, preset: 'content', bounty: { pool: '50' }, payout: { rule: 'pool', amounts: ['5'] } });
  assert.equal(winnerSlots(b), 10);
  assert.equal(winnerSlots(b, 2_000), 4); // an attached task's pool wins over the brief's
  assert.equal(winnerSlots({ ...b, payout: { ...b.payout, maxWinners: 3 } }), 3);
  assert.match(htmlToText(briefContent(b, 'run-1')), /paid 5 USDC, up to 10 submissions/);
});

test('the bounty text carries a template that parses back', () => {
  const b = validateBrief({ ...base, preset: 'dev', payout: { rule: 'one-winner', amounts: ['20'] } });
  const text = htmlToText(briefContent(b, 'run-1'));
  assert.ok(text.includes(renderTemplate(briefTemplate(b))));
  assert.ok(text.includes('pr (required): a link; a GitHub pull request with passing CI'));
  const filled = text.replace('pr: <link to your github pull request>', 'pr: https://github.com/a/b/pull/1').replace(/notes: <[^>]+>/, 'notes: did it');
  const p = parseTemplate(filled, briefTemplate(b));
  assert.deepEqual(p.fields.get('pr')!.urls, ['https://github.com/a/b/pull/1']);
});

// ---------- checks ----------

const stub = (routes: Record<string, number | { status?: number; body?: unknown } | Error>): FetchLike => async (url) => {
  const r = routes[url];
  if (r === undefined) throw new Error(`unexpected fetch ${url}`);
  if (r instanceof Error) throw r;
  const status = typeof r === 'number' ? r : (r.status ?? 200);
  return { status, ok: status < 300, json: async () => (typeof r === 'number' ? {} : r.body), body: null };
};
const ctxOf = (routes: Parameters<typeof stub>[0]): CheckContext => ({ fetch: stub(routes) });
const field = (url: string, text = url) => ({ text, urls: [url] });

test('reachable fails only on a missing page, and is cautious otherwise', async () => {
  const b = validateBrief({ ...base, preset: 'content' });
  const run = async (status: number | Error) => (await checkFields(b, { link: field('https://x.dev/a') }, ctxOf({ 'https://x.dev/a': status })))[0];
  assert.equal((await run(200)).status, 'pass');
  assert.deepEqual([(await run(404)).status, (await run(404)).fixable], ['fail', true]);
  assert.equal((await run(403)).status, 'warn', 'sites that block bots are unverified, not failed');
  assert.equal((await run(new Error('ECONNRESET'))).status, 'warn');
});

test('github check covers repo, state and CI', async () => {
  const b = validateBrief({ ...base, template: [{ id: 'pr', label: 'PR link', type: 'url', checks: [{ github: { repo: 'acme/sdk' } }] }] });
  const api = 'https://api.github.com/repos/acme/sdk';
  const pr = (n: number, body: unknown, runs?: unknown) => ({ [`${api}/pulls/${n}`]: { body }, ...(runs ? { [`${api}/commits/s${n}/check-runs`]: { body: { check_runs: runs } } } : {}) });
  const check = async (url: string, routes: Parameters<typeof stub>[0] = {}) => (await checkFields(b, { pr: field(url) }, ctxOf(routes))).map((c) => [c.id, c.status, c.fixable]);

  assert.deepEqual(await check('https://gitlab.com/acme/sdk/-/merge_requests/1'), [['github', 'fail', true]]);
  assert.deepEqual(await check('https://github.com/other/sdk/pull/1'), [['github', 'fail', false]], 'wrong repo disqualifies');
  assert.deepEqual(await check(`https://github.com/acme/sdk/pull/1`, pr(1, { state: 'open', head: { sha: 's1' } }, [{ name: 't', status: 'completed', conclusion: 'success' }])), [['github', 'pass', false], ['ci', 'pass', false]]);
  assert.deepEqual((await check(`https://github.com/acme/sdk/pull/2`, pr(2, { state: 'closed', merged: false, head: { sha: 's2' } }, [{ name: 't', status: 'completed', conclusion: 'success' }])))[0], ['github', 'fail', true]);
  assert.deepEqual((await check(`https://github.com/acme/sdk/pull/3`, pr(3, { state: 'open', head: { sha: 's3' } }, [{ name: 't', status: 'completed', conclusion: 'failure' }])))[1], ['ci', 'fail', true]);
  assert.deepEqual((await check(`https://github.com/acme/sdk/pull/4`, pr(4, { state: 'open', head: { sha: 's4' } }, [{ name: 't', status: 'in_progress', conclusion: null }])))[1], ['ci', 'warn', false]);
  assert.deepEqual(await check(`https://github.com/acme/sdk/pull/5`, { [`${api}/pulls/5`]: 403 }), [['github', 'warn', false]], 'rate limits are unverified, not failures');
});

test('word limits, domains and deadlines', async () => {
  const b = validateBrief({
    ...base,
    template: [
      { id: 'link', label: 'Link', type: 'url', checks: [{ domain: ['dev.to'] }] },
      { id: 'summary', label: 'Summary', type: 'text', checks: [{ words: { min: 3, max: 5 } }] },
    ],
  });
  const res = await checkFields(b, { link: field('https://blog.dev.to/x'), summary: { text: 'one two', urls: [] } }, ctxOf({}));
  assert.deepEqual(res.map((c) => [c.id, c.status]), [['domain', 'pass'], ['words', 'fail']]);
  assert.equal((await checkFields(b, { link: field('https://evil.example/dev.to') }, ctxOf({})))[0].status, 'fail');
  assert.equal(deadlineCheck('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')!.fixable, false);
  assert.equal(deadlineCheck('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), null);
  assert.equal(deadlineCheck('2026-01-01T00:00:00Z', null), null);
});

test('duplicates: the earliest keeps its place, copies and reused links do not', () => {
  const text = 'This guide explains how to create a payment, check its status and refund it with examples for every call.';
  const s = (id: string, mins: number, link: string, t: string) => ({ id, username: id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, mins)).toISOString(), fields: { link: field(link, link), summary: { text: t, urls: [] } } });
  const dups = findDuplicates(
    [
      s('copy', 20, 'https://b.dev/2', text.replace('guide', 'tutorial')),
      s('orig', 10, 'https://a.dev/1', text),
      s('relink', 30, 'https://A.dev/1/', 'Completely different words about something else that is long enough to compare here.'),
      s('fresh', 40, 'https://c.dev/3', 'An original walkthrough that charges a card from a Python script and handles every error case on the way.'),
      s('tiny', 50, 'https://d.dev/4', 'ok'),
    ],
    0.6,
  );
  assert.deepEqual([...dups.keys()].sort(), ['copy', 'relink']);
  assert.match(dups.get('relink')!.message, /same link as @orig/);
  assert.ok(similarity(text, text) === 1 && similarity('too short', 'too short') === 0);
});

test('verdicts: no fields is invalid, a non-fixable failure disqualifies, fixable ones need changes', () => {
  const f = { link: field('https://a.b') };
  const fail = (fixable: boolean) => ({ id: 'x', status: 'fail' as const, message: '', fixable });
  assert.equal(verdictOf({ fields: {}, checks: [] }), 'invalid');
  assert.equal(verdictOf({ fields: f, checks: [fail(true), fail(false)] }), 'disqualified');
  assert.equal(verdictOf({ fields: f, checks: [fail(true), { id: 'w', status: 'warn', message: '', fixable: false }] }), 'needs-changes');
  assert.equal(verdictOf({ fields: f, checks: [{ id: 'w', status: 'warn', message: '', fixable: false }] }), 'eligible');
});

// ---------- end to end on the simulator ----------

async function mockReview(brief: string) {
  const dir = await mkdtemp(join(tmpdir(), 'gibreview-'));
  const store = new Store<ReviewState>(join(dir, '.gibreview'));
  const client = createClient({ environment: 'mock', stateDir: store.dir });
  const b = await loadBrief(join(examples, brief));
  return { dir, store, client, b };
}

test('content bounty: publish, collect and rank on the simulator', async () => {
  const { store, client, b } = await mockReview('content-brief.yaml');
  const state = await publishBrief(b, 'content-brief.yaml', 'mock', client, store);
  assert.ok(state.task.id);
  const res = await collectReview(state, client, store, { fetch: mockFetch });
  assert.deepEqual(res.byVerdict, { eligible: 2, 'needs-changes': 2, disqualified: 2, invalid: 1 });

  const ranked = rankReview(state);
  const by = Object.fromEntries(ranked.map((r) => [r.submission.username, r]));
  assert.deepEqual(ranked.filter((r) => r.shortlisted).map((r) => r.submission.username), ['ada_writes', 'tunde.docs']);
  assert.deepEqual(by.kemi_b.submission.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['reachable'], 'only the dead link fails');
  assert.equal(by.shorty.submission.verdict, 'needs-changes');
  assert.match(by.copycat.reason, /same as @ada_writes/);
  assert.match(by.late_lara.reason, /after the deadline/);
  assert.equal(by.quickcash99.submission.verdict, 'invalid');
  assert.equal(by.quickcash99.place, null);

  // Collecting again keeps check results instead of fetching every link again.
  let fetches = 0;
  await collectReview(state, client, store, { fetch: async (u, i) => (fetches++, mockFetch(u, i)) });
  assert.equal(fetches, 0);
  await collectReview(state, client, store, { fetch: async (u, i) => (fetches++, mockFetch(u, i)) }, { recheck: true });
  assert.ok(fetches > 0);
  assert.equal(Object.keys((await store.load(state.runId)).submissions).length, 7, 'state saved to disk');
});

test('dev bounty: attach to an existing task and rank by reputation', async () => {
  const { store, client, b } = await mockReview('dev-brief.yaml');
  const published = await publishBrief(b, 'dev-brief.yaml', 'mock', client, store);
  const state = await attachTask(published.task.id!, b, 'dev-brief.yaml', 'mock', client, store);
  assert.equal(state.task.publishedBy, 'attached');
  assert.equal(state.task.pool, '50.00', 'pool read back from base units');
  assert.ok(state.task.deadline);

  await collectReview(state, client, store, { fetch: mockFetch });
  const ranked = rankReview(state);
  const verdict = Object.fromEntries(ranked.map((r) => [r.submission.username, r.submission.verdict]));
  assert.deepEqual(verdict, {
    ada_dev: 'eligible',
    'tunde.codes': 'eligible',
    kemi_b: 'needs-changes',
    closed_carl: 'needs-changes',
    wrongrepo_will: 'disqualified',
    late_lara: 'disqualified',
    quickcash99: 'invalid',
  });
  assert.equal(ranked[0].submission.username, 'ada_dev', 'reputation breaks the tie');
  assert.equal(ranked.filter((r) => r.shortlisted).length, 1, 'one-winner shortlists one');
});

test('a brief without a bounty section cannot be published', async () => {
  const { dir, store, client } = await mockReview('content-brief.yaml');
  const path = join(dir, 'b.yaml');
  await writeFile(path, 'name: No money\npreset: content\ndescription: Just reviewing an existing bounty.\npayout: { rule: one-winner, amounts: ["10"] }\n');
  await assert.rejects(publishBrief(await loadBrief(path), path, 'mock', client, store), /no bounty section/);
});
