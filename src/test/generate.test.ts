import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractModel } from '../generate/extract.js';
import { generatePlan, writePlanFile } from '../generate/index.js';
import { planRun } from '../engine.js';
import { Store } from '../state.js';
import { PlanError } from '../plan.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'fixtures', 'checkout.html');
const URL_ = 'https://staging.acme-shop.example/checkout';

test('extracts forms, labels, constraints, actions and nav links', async () => {
  const page = extractModel(await readFile(fixture, 'utf8'), URL_);
  assert.equal(page.title, 'Checkout · Acme Shop');
  assert.equal(page.forms.length, 2);
  const main = page.forms[0];
  assert.equal(main.submitLabel, 'Pay now');
  const byName = Object.fromEntries(main.fields.map((f) => [f.name, f]));
  assert.equal(byName.fullname.label, 'Full name');
  assert.equal(byName.fullname.minLength, 3);
  assert.equal(byName.phone.type, 'tel');
  assert.equal(byName.qty.max, '5');
  assert.deepEqual(byName.pay.options, ['Card', 'Bank transfer']);
  assert.equal(byName.terms.required, true);
  assert.deepEqual(page.actions, ['Edit cart']);
  assert.ok(page.links.every((l) => l.href.startsWith('https://staging.acme-shop.example/')));
  assert.equal(page.imagesMissingAlt, 1);
});

test('rule-based writer drafts a schema-valid plan without an API key', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await generatePlan({ url: URL_, htmlFile: fixture, maxCases: 12 });
  assert.equal(res.source, 'rules');
  assert.equal(res.plan.draft, true);
  assert.equal(res.plan.cases.length, 12);
  const titles = res.plan.cases.map((c) => c.title);
  assert.ok(titles.some((t) => /required fields/.test(t)));
  assert.ok(titles.some((t) => /double tap/.test(t)), 'payment forms get a double-submit case');
  assert.ok(titles.some((t) => /coupon/i.test(t)));
  assert.ok(!res.plan.cases[1].steps.some((s) => /Coupon/.test(s)), 'happy path leaves optional fields alone');
});

test('generated drafts are refused until a person removes draft: true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gibreview-gen-'));
  const res = await generatePlan({ url: URL_, htmlFile: fixture });
  const file = join(dir, 'testplan.yaml');
  await writePlanFile(file, res.yaml);
  const store = new Store(join(dir, '.gibreview/qa'));
  await assert.rejects(planRun(file, store, 'mock'), (e: unknown) => e instanceof PlanError && /draft/.test(e.message));
  await writeFile(file, (await readFile(file, 'utf8')).replace('draft: true\n', ''));
  const { run } = await planRun(file, store, 'mock');
  assert.ok(run.batches.length > 0);
});

async function withStubAi(reply: unknown, fn: () => Promise<void>) {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  process.env.GIBREVIEW_AI_URL = `http://127.0.0.1:${port}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    await fn();
  } finally {
    delete process.env.GIBREVIEW_AI_URL;
    delete process.env.ANTHROPIC_API_KEY;
    server.close();
  }
  return seen;
}

test('AI writer output is validated and used when ANTHROPIC_API_KEY is set', async () => {
  const reply = {
    cases: [
      { title: 'Pay with card using the test card', priority: 'high', steps: ['Fill the form', 'Tap "Pay now"'], expected: 'Order confirmation with an order number', reviewNote: 'Confirm order number format' },
      { title: 'Coupon SAVE10 reduces total', priority: 'high', steps: ['Enter SAVE10', 'Apply'], expected: 'Total drops by 10 percent', devices: ['android-chrome'] },
    ],
  };
  let res: Awaited<ReturnType<typeof generatePlan>> | undefined;
  const seen = await withStubAi(`Here you go:\n${JSON.stringify(reply)}`, async () => {
    res = await generatePlan({ url: URL_, htmlFile: fixture, describe: 'Coupon SAVE10 gives 10% off' });
  });
  assert.equal(res!.source, 'ai');
  assert.deepEqual(res!.plan.cases.map((c) => c.id), ['TC-01', 'TC-02']);
  assert.deepEqual(res!.plan.cases[1].devices, ['android-chrome']);
  const req = seen[0] as { headers: Record<string, string>; body: { messages: Array<{ content: string }> } };
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.match(req.body.messages[0].content, /SAVE10 gives 10% off/);
});

test('malformed AI output falls back to rule-based cases with a warning', async () => {
  let res: Awaited<ReturnType<typeof generatePlan>> | undefined;
  await withStubAi({ cases: [{ title: 'x' }] }, async () => {
    res = await generatePlan({ url: URL_, htmlFile: fixture });
  });
  assert.equal(res!.source, 'rules');
  assert.ok(res!.warnings.some((w) => /AI generation failed/.test(w)));
});
