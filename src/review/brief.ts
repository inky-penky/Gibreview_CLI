import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fromCents, PlanError, toCents, USDC_MINT } from '../plan.js';
import { htmlToText, renderTemplate, type Template } from '../template.js';

/**
 * A review brief: what a bounty asks for, the template submissions must follow, the checks that
 * decide whether a submission is acceptable, and how winners are paid. Presets supply defaults
 * for common bounty types so a brief can be a few lines long.
 */

export const SUBMISSION_HEADER = 'SUBMISSION';
export const SUBMISSION_FOOTER = 'END';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'must be an amount like "5" or "5.50"');

const CheckSpec = z.union([
  z.literal('reachable'),
  z.object({ domain: z.array(z.string().min(3)).min(1) }),
  z.object({ words: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(1).optional() }) }),
  z.object({ github: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like owner/name').optional(), requireCi: z.boolean().default(true) }) }),
]);
export type CheckSpec = z.infer<typeof CheckSpec>;

const FieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'field id must be lowercase, e.g. "link" or "pr"'),
  label: z.string().min(2),
  type: z.enum(['url', 'text']),
  required: z.boolean().default(true),
  checks: z.array(CheckSpec).default([]),
});
export type BriefField = z.infer<typeof FieldSchema>;

export const PRESETS = ['content', 'dev', 'custom'] as const;

/**
 * How a bounty pays, matching what Gibwork supports:
 * one-winner pays one submission, multiple-winners pays a set amount per place (top 3, top 10),
 * pool pays every accepted submission the same amount until the pool runs out.
 */
export const PAYOUT_RULES = ['one-winner', 'multiple-winners', 'pool'] as const;
export type PayoutRule = (typeof PAYOUT_RULES)[number];

/** The categories on Gibwork's "Create Bounty" page. */
export const SITE_CATEGORIES = ['Social Media', 'Development', 'Design', 'Feedback', 'Misc'] as const;
export type SiteCategory = (typeof SITE_CATEGORIES)[number];

/**
 * Who can participate, as on the website's options tab. The SDK can set verified and discord;
 * link ("Only to those with a Link") exists only on the website.
 */
export const ACCESS = ['everyone', 'verified', 'discord', 'link'] as const;
export const ACCESS_LABEL: Record<(typeof ACCESS)[number], string> = {
  everyone: 'Open to Everyone',
  verified: 'Only Verified Accounts',
  discord: 'Only Discord Members',
  link: 'Only to those with a Link',
};
export type Preset = (typeof PRESETS)[number];

const PRESET_FIELDS: Record<Exclude<Preset, 'custom'>, z.input<typeof FieldSchema>[]> = {
  content: [
    { id: 'link', label: 'Link to your published work', type: 'url', checks: ['reachable'] },
    { id: 'summary', label: 'One-paragraph summary of what you made', type: 'text', checks: [{ words: { min: 30, max: 250 } }] },
  ],
  dev: [
    { id: 'pr', label: 'Link to your GitHub pull request', type: 'url', checks: [{ github: { requireCi: true } }] },
    { id: 'notes', label: 'What you changed and how you tested it', type: 'text', checks: [{ words: { min: 15, max: 400 } }] },
  ],
};

export const BriefSchema = z
  .object({
    name: z.string().min(3),
    preset: z.enum(PRESETS).default('custom'),
    description: z.string().min(10),
    /** Only needed when the copilot publishes the bounty; omit when attaching to an existing one. */
    bounty: z
      .object({
        /** Everything put into escrow; winners are paid out of it, and close refunds the rest. */
        pool: money,
        /**
         * Gibwork's "minimum payment": the least any approved submission is paid. Defaults to the smallest
         * payout amount. On the website it is the payment tab (a tier or a custom minimum).
         */
        minimum: money.optional(),
        /** The website's category. Defaults to the preset's: Development for dev, Misc otherwise. */
        category: z.enum(SITE_CATEGORIES).optional(),
        /** Who can participate, as on the website's options tab. */
        access: z.enum(ACCESS).default('everyone'),
        /** Required with access: discord. */
        discord: z.object({ guildId: z.string().min(1), guildName: z.string().min(1), invite: z.string().url().optional(), roleIds: z.array(z.string()).default([]) }).optional(),
        mintAddress: z.string().default(USDC_MINT),
        symbol: z.string().default('USDC'),
        deadlineHours: z.number().int().min(1).max(24 * 60).optional(),
        /** Extra tags; the category is always included. */
        tags: z.array(z.string()).default([]),
      })
      .optional(),
    template: z.array(FieldSchema).min(1).optional(),
    criteria: z.array(z.object({ text: z.string().min(3), weight: z.number().int().min(1).max(100).default(1) })).default([]),
    /** Required: the creator states how winners are paid, nothing is assumed. */
    payout: z.object({
      rule: z.enum(PAYOUT_RULES, { message: `payout.rule must be one of ${PAYOUT_RULES.join(', ')}` }),
      /** one-winner: the winner's amount. multiple-winners: one amount per place. pool: what each accepted submission earns. */
      amounts: z.array(money).min(1),
      /** pool only: most submissions to pay. Without it, the pool pays as many as it covers. */
      maxWinners: z.number().int().min(1).optional(),
    }, { message: `payout is required: say whether this bounty pays ${PAYOUT_RULES.join(', ')}` }),
    review: z
      .object({
        /** Similarity (0 to 1) at or above which a later submission is a duplicate of an earlier one. */
        duplicates: z.number().min(0.5).max(1).default(0.85),
        /** Tie-breaker after check results: who submitted first, or the submitter's Gibwork track record. */
        order: z.enum(['first-come', 'reputation']).default('first-come'),
      })
      .default({ duplicates: 0.85, order: 'first-come' }),
  })
  .transform((b, ctx) => {
    const template = b.template ?? (b.preset === 'custom' ? undefined : PRESET_FIELDS[b.preset].map((f) => FieldSchema.parse(f)));
    if (!template) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: 'a custom brief needs a template (list of fields)' });
      return z.NEVER;
    }
    return { ...b, template };
  })
  .superRefine((b, ctx) => {
    const ids = new Set<string>();
    b.template.forEach((f, i) => {
      if (ids.has(f.id)) ctx.addIssue({ code: 'custom', path: ['template', i, 'id'], message: `duplicate field id ${f.id}` });
      ids.add(f.id);
      f.checks.forEach((c, j) => {
        const needsUrl = c === 'reachable' || 'domain' in c || 'github' in c;
        if (needsUrl && f.type !== 'url') ctx.addIssue({ code: 'custom', path: ['template', i, 'checks', j], message: `this check needs a url field, ${f.id} is text` });
        if (typeof c === 'object' && 'words' in c && f.type !== 'text') ctx.addIssue({ code: 'custom', path: ['template', i, 'checks', j], message: `words needs a text field, ${f.id} is a url` });
      });
    });
    if (b.payout.rule === 'one-winner' && b.payout.amounts.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: 'one-winner pays one amount; use multiple-winners for several places' });
    }
    if (b.payout.rule === 'pool' && b.payout.amounts.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: 'pool pays every accepted submission the same amount; use multiple-winners for different amounts per place' });
    }
    if (b.payout.rule !== 'pool' && b.payout.maxWinners) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'maxWinners'], message: `maxWinners only applies to pool; ${b.payout.rule} pays one submission per listed amount` });
    }
    if (b.payout.amounts.some((a) => toCents(a) === 0)) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: 'every payout amount must be more than 0' });
    }
    if (b.bounty?.minimum) {
      const min = b.bounty.minimum;
      b.payout.amounts.forEach((a, i) => {
        if (toCents(a) < toCents(min)) {
          ctx.addIssue({ code: 'custom', path: ['payout', 'amounts', i], message: `${a} is below the bounty's minimum of ${min} per approved submission; Gibwork cannot pay it` });
        }
      });
    }
    if (b.bounty?.access === 'discord' && !b.bounty.discord) {
      ctx.addIssue({ code: 'custom', path: ['bounty', 'discord'], message: 'access: discord needs discord.guildId and discord.guildName' });
    }
    if (b.bounty && b.payout.rule === 'pool' && winnerSlots(b) === 0) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: `the pool of ${b.bounty.pool} cannot cover one payment of ${b.payout.amounts[0]}` });
    }
    if (b.bounty && totalPayoutCents(b) > toCents(b.bounty.pool)) {
      ctx.addIssue({ code: 'custom', path: ['payout'], message: `payouts add up to ${fromCents(totalPayoutCents(b))}, more than the pool of ${b.bounty.pool}` });
    }
  });

export type Brief = z.output<typeof BriefSchema>;

/** Most the payout rule can pay in total. */
export function totalPayoutCents(b: Pick<Brief, 'payout' | 'bounty'>, poolCents?: number): number {
  const p = b.payout;
  if (p.rule === 'pool') return toCents(p.amounts[0]) * winnerSlots(b, poolCents);
  return p.amounts.reduce((n, a) => n + toCents(a), 0);
}

/**
 * How many submissions the payout rule pays, which is how long the shortlist is. A pool without
 * maxWinners pays as many as it covers: the attached task's pool when given, else the brief's.
 */
export function winnerSlots(b: Pick<Brief, 'payout' | 'bounty'>, poolCents?: number): number {
  const p = b.payout;
  if (p.rule !== 'pool') return p.amounts.length;
  if (p.maxWinners) return p.maxWinners;
  const pool = poolCents ?? (b.bounty ? toCents(b.bounty.pool) : 0);
  return Math.floor(pool / toCents(p.amounts[0]));
}

/** What the place pays (1-based). Every place pays the same in a pool. */
export function placeAmount(b: Pick<Brief, 'payout'>, place: number): string {
  return b.payout.rule === 'pool' ? b.payout.amounts[0] : b.payout.amounts[place - 1];
}

export function validateBrief(raw: unknown): Brief {
  const r = BriefSchema.safeParse(raw);
  if (!r.success) throw new PlanError('Brief is invalid', r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return r.data;
}

export async function loadBrief(path: string): Promise<Brief> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new PlanError(`Cannot read brief at ${path}`);
  }
  try {
    return validateBrief(path.endsWith('.json') ? JSON.parse(text) : parseYaml(text));
  } catch (err) {
    if (err instanceof PlanError) throw err;
    throw new PlanError(`Cannot parse ${path}: ${(err as Error).message}`);
  }
}

export function briefTemplate(b: Pick<Brief, 'template'>): Template {
  return {
    header: SUBMISSION_HEADER,
    footer: SUBMISSION_FOOTER,
    fields: b.template.map((f) => ({ key: f.id, type: f.type, required: f.required, placeholder: `<${f.label.toLowerCase()}>` })),
  };
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- published rules ----------
//
// The bounty lists every field's rules on one line in a fixed wording, e.g.
//   pr (required): a link; a GitHub pull request on acme/payments-sdk with passing CI
// People read it as plain English, and the participant pre-check parses it back, because a
// participant never sees the creator's brief. ruleLine and parseRuleLine must stay inverses.

function describeCheck(c: CheckSpec): string {
  if (c === 'reachable') return 'must open';
  if ('domain' in c) return `must be on ${c.domain.join(', ')}`;
  if ('words' in c) {
    const { min, max } = c.words;
    if (max === undefined) return `at least ${min ?? 0} words`;
    return min ? `${min} to ${max} words` : `at most ${max} words`;
  }
  return `a GitHub pull request${c.github.repo ? ` on ${c.github.repo}` : ''}${c.github.requireCi ? ' with passing CI' : ''}`;
}

export function ruleLine(f: BriefField): string {
  return `${f.id} (${f.required ? 'required' : 'optional'}): ${[f.type === 'url' ? 'a link' : 'text', ...f.checks.map(describeCheck)].join('; ')}`;
}

// "id (required):" rather than "id:", so a participant who pastes the rules into a submission
// never has a rule read as their answer.
const RULE_LINE = /^\s*(?:[-•*]\s*)?([a-z][a-z0-9_-]*) \((required|optional)\): (a link|text)((?:; [^;\n]+)*)\s*$/;

function parseCheck(clause: string): CheckSpec | null {
  let m: RegExpMatchArray | null;
  if (clause === 'must open') return 'reachable';
  if ((m = clause.match(/^must be on (.+)$/))) return { domain: m[1].split(',').map((d) => d.trim()).filter(Boolean) };
  if ((m = clause.match(/^(\d+) to (\d+) words$/))) return { words: { min: Number(m[1]), max: Number(m[2]) } };
  if ((m = clause.match(/^at least (\d+) words$/))) return { words: { min: Number(m[1]) } };
  if ((m = clause.match(/^at most (\d+) words$/))) return { words: { max: Number(m[1]) } };
  if ((m = clause.match(/^a GitHub pull request(?: on ([\w.-]+\/[\w.-]+))?( with passing CI)?$/))) {
    return { github: { ...(m[1] ? { repo: m[1] } : {}), requireCi: Boolean(m[2]) } };
  }
  return null;
}

/**
 * Reads the fields and checks back from a bounty's text (plain text or HTML already converted).
 * Labels come from the placeholders in the SUBMISSION block. Returns null when the bounty lists no rules,
 * for example one written by hand on the Gibwork site. Throws on a rule it cannot read, rather than skip it.
 */
export function rulesFromContent(text: string): BriefField[] | null {
  const labels = new Map([...text.matchAll(/^([a-z][a-z0-9_-]*): <([^>\n]+)>\s*$/gm)].map((m) => [m[1], m[2]]));
  const fields: BriefField[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(RULE_LINE);
    if (!m) continue;
    const clauses = m[4].split(';').map((c) => c.trim()).filter(Boolean);
    const checks = clauses.map((c) => {
      const spec = parseCheck(c);
      if (!spec) throw new PlanError(`Cannot read the rule "${c}" for ${m[1]} in this bounty. Update gibreview, or ask the creator for the brief.`);
      return spec;
    });
    fields.push({ id: m[1], label: labels.get(m[1]) ?? m[1], type: m[3] === 'a link' ? 'url' : 'text', required: m[2] === 'required', checks });
  }
  return fields.length ? fields : null;
}

/**
 * Bounty text for Gibwork: the task, what to submit, the rules a submission is checked against, and the payout.
 * runId is set when gibreview publishes; text for pasting into the website editor has none.
 */
export function briefContent(b: Brief, runId?: string): string {
  const sym = b.bounty?.symbol ?? 'USDC';
  const parts: string[] = [];
  parts.push(...b.description.trim().split(/\n{2,}/).map((p) => `<p>${esc(p.trim())}</p>`));
  if (b.criteria.length) {
    parts.push('<h3>How submissions are judged</h3>');
    parts.push(`<ul>${b.criteria.map((c) => `<li>${esc(c.text)}${b.criteria.length > 1 ? ` (${c.weight})` : ''}</li>`).join('')}</ul>`);
  }
  parts.push('<h3>How to submit</h3>');
  parts.push('<p>Paste this block into your submission and replace every &lt;placeholder&gt;.</p>');
  parts.push(`<pre>${esc(renderTemplate(briefTemplate(b)))}</pre>`);
  parts.push('<p>Every submission is checked automatically against these rules:</p>');
  parts.push(`<ul>${b.template.map((f) => `<li>${esc(ruleLine(f))}</li>`).join('')}</ul>`);
  parts.push('<p>Copies of another submission and work sent after the deadline are not accepted.</p>');
  parts.push('<p>Check your submission for free before you send it: <code>npx gibreview check &lt;this bounty id&gt; my-submission.txt</code></p>');
  const amounts = b.payout.amounts.map((a) => `${a} ${sym}`);
  const how =
    b.payout.rule === 'multiple-winners'
      ? `The top ${amounts.length} are paid ${amounts.map((a, i) => `${ordinal(i + 1)} ${a}`).join(', ')}.`
      : b.payout.rule === 'pool'
        ? `Every accepted submission is paid ${amounts[0]}, ${winnerSlots(b) ? `up to ${winnerSlots(b)} submissions` : 'until the pool runs out'}.`
        : `The best submission is paid ${amounts[0]}.`;
  parts.push(`<p><strong>Payout:</strong> ${esc(how)}</p>`);
  if (runId) parts.push(`<p><small>Ref ${esc(runId)}. Reviewed with gibwork-review.</small></p>`);
  return parts.join('\n');
}

/** The bounty description as plain text, to paste into the editor on the Gibwork website. */
export function briefText(b: Brief): string {
  return htmlToText(briefContent(b));
}

const PRESET_CATEGORY: Record<Preset, SiteCategory> = { dev: 'Development', content: 'Misc', custom: 'Misc' };

export function siteCategory(b: Pick<Brief, 'bounty' | 'preset'>): SiteCategory {
  return b.bounty?.category ?? PRESET_CATEGORY[b.preset];
}

/** The least any approved submission is paid: the brief's minimum, or else its smallest payout amount. */
export function minimumPayment(b: Pick<Brief, 'bounty' | 'payout'>): string {
  return b.bounty?.minimum ?? fromCents(Math.min(...b.payout.amounts.map(toCents)));
}

/**
 * The lowest minimum the website offered ("Anyone" tier) when checked on 2026-10-27: $25 with Development
 * selected, $10 before a category was chosen. Only used for a warning; Gibwork has the final say.
 */
export function siteLowestTier(category: SiteCategory): number {
  return category === 'Development' ? 25 : 10;
}

/**
 * Whether a bounty's text lists the same rules as the brief. Participants' pre-checks read the bounty,
 * so a bounty without them (or with different ones) is checked against something else than the review.
 */
export function compareRules(template: BriefField[], bountyContent: string): 'match' | 'differ' | 'missing' {
  const text = /<[a-z][\s\S]*>/i.test(bountyContent) ? htmlToText(bountyContent) : bountyContent;
  let published: BriefField[] | null;
  try {
    published = rulesFromContent(text);
  } catch {
    return 'differ';
  }
  if (!published) return 'missing';
  const key = (fs: BriefField[]) => JSON.stringify(fs.map((f) => [f.id, f.type, f.required, f.checks]));
  return key(published) === key(template) ? 'match' : 'differ';
}
