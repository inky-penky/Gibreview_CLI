import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanError } from '../plan.js';
import { htmlToText } from '../template.js';
import { briefContent, loadBrief, ruleLine, rulesFromContent, validateBrief } from '../review/brief.js';
import { precheck } from '../review/precheck.js';
import { mockFetch } from '../review/mockweb.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'review');
const ctx = { fetch: mockFetch };
const base = { name: 'Guide', description: 'Write a guide to the API.', payout: { rule: 'one-winner', amounts: ['10'] } };
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('the rules published in a bounty read back exactly as the brief wrote them', async () => {
  const custom = validateBrief({
    ...base,
    template: [
      { id: 'link', label: 'Link to your post', type: 'url', checks: ['reachable', { domain: ['dev.to', 'medium.com'] }] },
      { id: 'summary', label: 'Short summary', type: 'text', required: false, checks: [{ words: { min: 10 } }, { words: { max: 90 } }] },
      { id: 'pr', label: 'Pull request', type: 'url', checks: [{ github: { requireCi: false } }] },
    ],
  });
  for (const b of [await loadBrief(join(examples, 'content-brief.yaml')), await loadBrief(join(examples, 'dev-brief.yaml')), custom]) {
    const fields = rulesFromContent(htmlToText(briefContent(b, 'run-1')));
    assert.deepEqual(
      fields!.map((f) => ({ ...f, label: f.label.toLowerCase() })),
      b.template.map((f) => ({ ...f, label: f.label.toLowerCase() })),
    );
  }
  assert.equal(ruleLine(custom.template[0]), 'link (required): a link; must open; must be on dev.to, medium.com');
  assert.equal(rulesFromContent('A bounty written by hand.\nlink: send me a link'), null);
  assert.throws(() => rulesFromContent('pr (required): a link; must be reviewed by Bob'), /Cannot read the rule "must be reviewed by Bob"/);
});

async function devBounty(deadline: string | null = null) {
  const b = await loadBrief(join(examples, 'dev-brief.yaml'));
  return { content: briefContent(b, 'run-1'), deadline };
}
const draft = (pr: string, notes = words(20)) => `SUBMISSION\npr: ${pr}\nnotes: ${notes}\nEND`;

test('pre-check: a good draft is ready, with what a pre-check cannot know', async () => {
  const res = await precheck(await devBounty(), draft('https://github.com/acme/payments-sdk/pull/41'), ctx);
  assert.equal(res.rules, 'bounty');
  assert.deepEqual(res.fields, ['pr', 'notes']);
  assert.equal(res.verdict, 'eligible');
  assert.ok(res.ready);
  assert.equal(res.summary, 'Ready to submit: every check passed.');
  assert.ok(res.limits.some((l) => /Copies/.test(l)));
});

test('pre-check: fixable problems are listed, unfixable ones are called out', async () => {
  const failing = await precheck(await devBounty(), draft('https://github.com/acme/payments-sdk/pull/45', 'too short'), ctx);
  assert.equal(failing.verdict, 'needs-changes');
  assert.match(failing.summary, /^Fix these 2 problems before you submit: CI failing on acme\/payments-sdk#45.*notes has 2 words, needs at least 15/);

  const wrongRepo = await precheck(await devBounty(), draft('https://github.com/someone/else/pull/3'), ctx);
  assert.equal(wrongRepo.verdict, 'disqualified');
  assert.match(wrongRepo.summary, /^This would not be accepted: pull request is on someone\/else/);

  const late = await precheck(await devBounty('2026-01-01T00:00:00Z'), draft('https://github.com/acme/payments-sdk/pull/41'), ctx, { now: new Date('2026-02-01') });
  assert.equal(late.verdict, 'disqualified');
  assert.match(late.summary, /deadline \(2026-01-01T00:00:00Z\) has passed/);
});

test('pre-check: placeholders and missing blocks are not mistaken for answers', async () => {
  const bounty = await devBounty();
  const untouched = await precheck(bounty, draft('<link to your github pull request>'), ctx);
  assert.equal(untouched.verdict, 'needs-changes');
  assert.ok(untouched.checks.some((c) => c.message === 'pr is missing or has no link'));

  const none = await precheck(bounty, 'done, check my github 👍', ctx);
  assert.equal(none.verdict, 'invalid');
  assert.match(none.summary, /fill in pr, notes/);

  // Pasting the bounty's rule list along with the block does not change the answers.
  const pasted = `${htmlToText(bounty.content)}\n${draft('https://github.com/acme/payments-sdk/pull/41')}`;
  assert.ok((await precheck(bounty, pasted, ctx)).ready);
});

test('pre-check: a hand-written bounty needs the creator brief', async () => {
  const bounty = { content: '<p>Fix the retry bug and send me the PR link.</p>', deadline: null };
  await assert.rejects(precheck(bounty, draft('https://github.com/acme/payments-sdk/pull/41'), ctx), (e) => e instanceof PlanError && /does not list gibreview rules/.test(e.message));
  const b = await loadBrief(join(examples, 'dev-brief.yaml'));
  const res = await precheck(bounty, draft('https://github.com/acme/payments-sdk/pull/41'), ctx, { template: b.template });
  assert.equal(res.rules, 'brief');
  assert.ok(res.ready);
});
