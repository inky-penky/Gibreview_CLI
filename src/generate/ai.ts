import { z } from 'zod';
import type { PageModel } from './extract.js';
import type { DraftCase } from './rules.js';

/**
 * Optional LLM pass: takes the extracted page and the rule-based baseline and returns a sharper,
 * more realistic set of cases. Uses the Anthropic Messages API over fetch, so there is no extra dependency.
 * Output is validated; anything malformed falls back to the rule-based cases.
 */

export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';

const AiCase = z.object({
  title: z.string().min(3),
  priority: z.enum(['high', 'medium', 'low']),
  preconditions: z.string().optional(),
  steps: z.array(z.string().min(1)).min(1).max(15),
  expected: z.string().min(3),
  devices: z.array(z.enum(['android-chrome', 'ios-safari', 'desktop'])).optional(),
  reviewNote: z.string().optional(),
});
const AiResponse = z.object({ cases: z.array(AiCase).min(1).max(40) });

const SYSTEM = `You are a senior QA engineer writing manual test cases that paid crowd testers will run on real phones and computers.
Testers are not developers. Every step must be a concrete action they can do with the page in front of them, and every expected result must be something they can see.
Rules:
- Cover the main happy path first, then validation, edge cases, error recovery, mobile layout and accessibility.
- Use the real field labels, button texts and constraints from the page model. Give concrete input values.
- Never invent business rules you cannot see. When the right expected result depends on product knowledge, write the most reasonable expectation and add a short reviewNote saying what a human must confirm.
- Keep each case finishable in under 5 minutes. Prefer fewer, sharper cases over many vague ones.
- Never ask testers to use real payment details or personal data.
- priority is high for anything that blocks the main task or loses money, medium for validation and important UX, low for polish.
- devices is optional. Use it only when a case only makes sense on some of: android-chrome, ios-safari, desktop.
Reply with JSON only, no prose, matching {"cases":[{"title","priority","preconditions"?,"steps":[],"expected","devices"?,"reviewNote"?}]}.`;

export interface AiOptions {
  apiKey: string;
  model?: string;
  maxCases: number;
  describe?: string;
  endpoint?: string;
}

export async function aiCases(page: PageModel, baseline: DraftCase[], opts: AiOptions): Promise<DraftCase[]> {
  const user = [
    `Write at most ${opts.maxCases} test cases for this feature.`,
    opts.describe ? `What the team says the feature does:\n${opts.describe}` : '',
    `Page model extracted from ${page.url}:\n${JSON.stringify({ ...page, renderedWith: undefined }, null, 1)}`,
    `Rule-based baseline cases (improve, merge, drop or extend them):\n${JSON.stringify(baseline)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await fetch(opts.endpoint ?? process.env.BUGBASH_AI_URL ?? 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: opts.model ?? process.env.BUGBASH_AI_MODEL ?? DEFAULT_AI_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI request failed with HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('AI reply was not valid JSON');
  }
  const out = AiResponse.safeParse(parsed);
  if (!out.success) throw new Error(`AI reply did not match the case schema: ${out.error.issues[0]?.message}`);
  return out.data.cases.slice(0, opts.maxCases);
}
