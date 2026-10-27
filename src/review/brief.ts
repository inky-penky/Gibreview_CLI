import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fromCents, PlanError, toCents, USDC_MINT } from '../plan.js';
import { renderTemplate, type Template } from '../template.js';

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
        pool: money,
        mintAddress: z.string().default(USDC_MINT),
        symbol: z.string().default('USDC'),
        deadlineHours: z.number().int().min(1).max(24 * 60).optional(),
        tags: z.array(z.string()).default(['Bounty']),
      })
      .optional(),
    template: z.array(FieldSchema).min(1).optional(),
    criteria: z.array(z.object({ text: z.string().min(3), weight: z.number().int().min(1).max(100).default(1) })).default([]),
    payout: z
      .object({
        rule: z.enum(['winner', 'top-n', 'threshold']).default('winner'),
        /** top-n: one amount per place. winner and threshold: one amount per paid submission. */
        amounts: z.array(money).min(1),
        /** threshold: most submissions to pay. Defaults to as many as the pool covers. */
        maxWinners: z.number().int().min(1).optional(),
      })
      .optional(),
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
    if (b.payout?.rule === 'winner' && b.payout.amounts.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: 'winner pays one amount; use top-n for several places' });
    }
    if (b.payout?.rule === 'threshold' && b.payout.amounts.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['payout', 'amounts'], message: 'threshold pays every accepted submission the same amount; use top-n for different amounts per place' });
    }
    if (b.bounty && b.payout && totalPayoutCents(b) > toCents(b.bounty.pool)) {
      ctx.addIssue({ code: 'custom', path: ['payout'], message: `payouts add up to ${fromCents(totalPayoutCents(b))}, more than the pool of ${b.bounty.pool}` });
    }
  });

export type Brief = z.output<typeof BriefSchema>;

/** Most the payout rule can pay in total. */
export function totalPayoutCents(b: Pick<Brief, 'payout' | 'bounty'>, poolCents?: number): number {
  const p = b.payout;
  if (!p) return 0;
  const cents = p.amounts.map(toCents);
  if (p.rule === 'top-n') return cents.reduce((n, c) => n + c, 0);
  if (p.rule === 'threshold') return cents[0] * winnerSlots(b, poolCents);
  return cents[0];
}

/**
 * How many submissions the payout rule pays, which is how long the shortlist is. A threshold
 * without maxWinners pays as many as the pool covers: the brief's pool, or the attached task's.
 */
export function winnerSlots(b: Pick<Brief, 'payout' | 'bounty'>, poolCents?: number): number {
  const p = b.payout;
  if (!p) return 1;
  if (p.rule === 'top-n') return p.amounts.length;
  if (p.rule !== 'threshold') return 1;
  if (p.maxWinners) return p.maxWinners;
  const pool = poolCents ?? (b.bounty ? toCents(b.bounty.pool) : 0);
  return Math.max(1, Math.floor(pool / toCents(p.amounts[0])));
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

export function briefTemplate(b: Brief): Template {
  return {
    header: SUBMISSION_HEADER,
    footer: SUBMISSION_FOOTER,
    fields: b.template.map((f) => ({ key: f.id, type: f.type, required: f.required, placeholder: `<${f.label.toLowerCase()}>` })),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function describeCheck(c: CheckSpec, field: BriefField): string {
  if (c === 'reachable') return `the ${field.id} link must open`;
  if ('domain' in c) return `the ${field.id} link must be on ${c.domain.join(', ')}`;
  if ('words' in c) return `${field.id} must be ${[c.words.min ? `at least ${c.words.min}` : '', c.words.max ? `at most ${c.words.max}` : ''].filter(Boolean).join(' and ')} words`;
  return `${field.id} must be a pull request${c.github.repo ? ` on ${c.github.repo}` : ''}${c.github.requireCi ? ' with passing CI' : ''}`;
}

/** Bounty text for Gibwork: the task, what to submit, the rules a submission is checked against, and the payout. */
export function briefContent(b: Brief, runId: string): string {
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
  const rules = b.template.flatMap((f) => [...(f.required ? [`${f.id} is required`] : []), ...f.checks.map((c) => describeCheck(c, f))]);
  parts.push(`<p>Every submission is checked automatically: ${esc(rules.join('; '))}. Copies of another submission and work sent after the deadline are not accepted.</p>`);
  if (b.payout) {
    const amounts = b.payout.amounts.map((a) => `${a} ${sym}`);
    const how =
      b.payout.rule === 'top-n'
        ? `Places are paid ${amounts.join(', ')}.`
        : b.payout.rule === 'threshold'
          ? `Every accepted submission is paid ${amounts[0]}, up to ${winnerSlots(b)} submissions.`
          : `The best submission is paid ${amounts[0]}.`;
    parts.push(`<p><strong>Payout:</strong> ${esc(how)}</p>`);
  }
  parts.push(`<p><small>Ref ${esc(runId)}. Reviewed with gibwork-review.</small></p>`);
  return parts.join('\n');
}
