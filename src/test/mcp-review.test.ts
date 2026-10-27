import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../state.js';
import { createClient } from '../gibwork.js';
import { loadBrief } from '../review/brief.js';
import { publishBrief, type ReviewState } from '../review/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', 'examples', 'review');

test('a creator agent reviews, plans, pays and closes a bounty through the review tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gibreview-mcp-'));
  // A bounty on the simulator, as if the creator had made it earlier.
  const sim = createClient({ environment: 'mock', stateDir: root });
  const published = await publishBrief(await loadBrief(join(examples, 'content-brief.yaml')), 'b', 'mock', sim, new Store<ReviewState>(join(root, 'scratch')));

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, '..', 'mcp.js')], env: { ...process.env, GIBREVIEW_DIR: root } as Record<string, string> }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = r.content[0].text;
    return { error: Boolean(r.isError), text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['review_text', 'review_attach', 'review_collect', 'review_score', 'review_rank', 'review_decide', 'review_close', 'review_status', 'review_precheck', 'qa_plan']) assert.ok(names.includes(t), t);

    const text = await call('review_text', { briefPath: join(examples, 'content-brief.yaml') });
    assert.deepEqual([text.data.category, text.data.minimum, text.data.bountyAmount.amount], ['Misc', '10.00', 50]);

    const attach = await call('review_attach', { taskId: published.task.id, briefPath: join(examples, 'content-brief.yaml'), environment: 'mock' });
    assert.match(attach.data.payments, /this server can pay/);
    assert.deepEqual((await call('review_collect')).data.byVerdict, { eligible: 2, 'needs-changes': 2, disqualified: 2, invalid: 1 });
    assert.equal((await call('review_rank', { outDir: join(root, 'report') })).data.shortlist[0].username, 'ada_writes');
    assert.match((await call('review_score')).text, /ANTHROPIC_API_KEY/);

    const dry = await call('review_decide');
    assert.equal(dry.data.payTotal, '40.00 USDC');
    assert.match(dry.data.confirmCode, /^pay-40\.00-USDC-/);

    const refused = await call('review_decide', { apply: true });
    assert.ok(refused.error);
    assert.match(refused.text, /ask them to approve it/);
    assert.ok((await call('review_decide', { apply: true, confirmCode: 'pay-40.00-USDC-000000' })).error, 'a wrong code is refused');

    const applied = await call('review_decide', { apply: true, confirmCode: dry.data.confirmCode });
    assert.ok(applied.data.actions.filter((a: { action: string }) => a.action !== 'hold').every((a: { outcome: string }) => a.outcome === 'done'));
    assert.deepEqual((await call('review_status')).data.paid, ['@ada_writes 25.00', '@tunde.docs 15.00']);

    assert.deepEqual((await call('review_close')).data.left, '10.00');
    assert.equal((await call('review_close', { confirm: true })).data.closed.refunded, '10.00');

    const check = await call('review_precheck', { taskId: published.task.id, environment: 'mock', submission: 'SUBMISSION\nlink: https://dev.to/x/guide-404\nsummary: short\nEND' });
    assert.equal(check.data.verdict, 'needs-changes');
  } finally {
    await client.close();
  }
});
