// Drives the BugBash MCP server exactly like an AI agent would, over stdio.
// Usage: node examples/mcp-agent-demo.mjs [path/to/testplan.yaml]
// Runs in mock mode, so no wallet or funds are needed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plan = resolve(process.argv[2] ?? join(root, 'examples', 'checkout-regression.yaml'));
const work = mkdtempSync(join(tmpdir(), 'bugbash-mcp-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'mcp.js')],
  cwd: work,
  env: { ...process.env, BUGBASH_DIR: join(work, '.bugbash') },
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
console.log(`Connected. Tools: ${tools.map((t) => t.name).join(', ')}`);

const planned = await call('bugbash_plan', { planPath: plan, environment: 'mock' });
await call('bugbash_publish', {}); // refused: the agent must show the cost and get a human yes first
await call('bugbash_publish', { confirmCode: 'publish-0.01-USDC-000000' }); // refused: code does not match this amount
console.log(`\n(agent shows the user ${planned.totalBudget} ${planned.symbol} and the user approves)`);
await call('bugbash_publish', { confirmCode: planned.confirmCode });
await call('bugbash_collect');
const preview = await call('bugbash_triage', {}); // dry run: payouts, rejections and a pay code
console.log(`\n(agent shows the user ${preview.payTotal} in payouts and the user approves)`);
await call('bugbash_triage', { apply: true, confirmCode: preview.confirmCode });
const report = await call('bugbash_report', { outDir: join(work, 'report') });

console.log(`\nAgent summary: release gate is ${report.gate.verdict}. ${report.gate.reasons.join('; ')}`);
console.log(`Reports in ${join(work, 'report')}`);
await client.close();
