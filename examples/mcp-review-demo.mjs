// An AI agent reviews a bounty through the gibreview MCP server, over stdio, from bounty text to payout.
// Usage: node examples/mcp-review-demo.mjs [path/to/brief.yaml]
// Runs in mock mode, so no wallet or funds are needed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'gibreview-mcp-review-'));
const stateDir = join(work, '.gibreview');
// The server runs in the work folder, so the agent can pass short relative paths.
const brief = 'brief.yaml';
copyFileSync(resolve(process.argv[2] ?? join(root, 'examples', 'review', 'content-brief.yaml')), join(work, brief));

// The creator's bounty, made outside the agent (on gibwork.com for real; on the simulator here).
const published = execFileSync(process.execPath, [join(root, 'dist', 'review', 'cli.js'), '--dir', stateDir, 'publish', brief, '--mock', '--confirm'], { cwd: work, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const taskId = /Published task (\S+)/.exec(published)[1];
console.log(`The creator's bounty is task ${taskId}. The agent takes it from here.`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'mcp.js')],
  cwd: work,
  env: { ...process.env, GIBREVIEW_DIR: stateDir },
});
const client = new Client({ name: 'demo-agent', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join('\n');
  console.log(`\n▶ agent calls ${name} ${JSON.stringify(args)}${res.isError ? '  (error)' : ''}`);
  console.log(text.length > 1400 ? `${text.slice(0, 1400)}\n…` : text);
  return res.isError ? null : JSON.parse(text);
};

const { tools } = await client.listTools();
console.log(`Connected. Review tools: ${tools.map((t) => t.name).filter((n) => n.startsWith('review_')).join(', ')}`);

// A participant's agent checks a draft before it is sent.
await call('review_precheck', {
  taskId,
  environment: 'mock',
  submission: 'SUBMISSION\nlink: https://dev.to/me/payments-guide-dead\nsummary: A short guide.\nEND',
});

// The creator's agent reviews.
await call('review_attach', { taskId, briefPath: brief, environment: 'mock' });
await call('review_collect');
await call('review_rank', { outDir: 'review-report' });
const plan = await call('review_decide', {}); // dry run: the plan, the total and a confirm code
await call('review_decide', { apply: true }); // refused: no confirm code, so the user has not approved yet
console.log(`\n(agent shows the user ${plan.payTotal} to ${plan.actions.filter((a) => a.action === 'pay').length} winners and the user approves)`);
await call('review_decide', { apply: true, confirmCode: plan.confirmCode });
await call('review_close', {}); // preview only: what is left in the pool
const status = await call('review_status');

console.log(`\nAgent summary: paid ${status.paid.join(', ')}; fix requests and rejections sent with a reason each.`);
console.log(`Shortlist in ${join(work, 'review-report')}`);
await client.close();
