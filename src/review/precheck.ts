import { PlanError } from '../plan.js';
import { htmlToText, missingFields, parseTemplate } from '../template.js';
import { briefTemplate, rulesFromContent, type BriefField } from './brief.js';
import { checkFields, type CheckContext, type CheckResult } from './checks.js';
import { verdictOf, type ReviewVerdict } from './engine.js';

/**
 * The participant's side of a review: run the creator's checks on a draft before sending it, for free.
 * The rules come from the bounty text (gibreview publishes them in a fixed wording), or from the
 * creator's brief when they share it. Nothing is submitted and no wallet funds are touched.
 */

export interface PrecheckResult {
  /** Where the rules came from. */
  rules: 'bounty' | 'brief';
  fields: string[];
  checks: CheckResult[];
  verdict: ReviewVerdict;
  ready: boolean;
  /** One line for the participant. */
  summary: string;
  /** What a pre-check cannot know. */
  limits: string[];
}

export interface BountyText {
  content: string;
  deadline: string | null;
}

export function bountyRules(bounty: BountyText): BriefField[] {
  const text = /<[a-z][\s\S]*>/i.test(bounty.content) ? htmlToText(bounty.content) : bounty.content;
  const fields = rulesFromContent(text);
  if (!fields) {
    throw new PlanError(
      'This bounty does not list gibreview rules, so there is nothing to check against.',
      ['It was probably written by hand on the Gibwork site. Ask the creator for their brief and pass it with --brief.'],
    );
  }
  return fields;
}

export async function precheck(bounty: BountyText, draft: string, ctx: CheckContext, opts: { template?: BriefField[]; now?: Date } = {}): Promise<PrecheckResult> {
  const fields = opts.template ?? bountyRules(bounty);
  const template = briefTemplate({ template: fields });
  const parsed = parseTemplate(draft, template);
  const values = Object.fromEntries([...parsed.fields].map(([k, v]) => [k, { text: v.text, urls: v.urls }]));
  const checks: CheckResult[] = [];

  const now = opts.now ?? new Date();
  if (bounty.deadline && now > new Date(bounty.deadline)) {
    checks.push({ id: 'deadline', status: 'fail', message: `the deadline (${bounty.deadline}) has passed`, fixable: false });
  }
  if (parsed.fields.size) {
    for (const f of missingFields(template, parsed)) {
      checks.push({ id: 'template', field: f.key, status: 'fail', message: `${f.key} is missing${f.type === 'url' ? ' or has no link' : ''}`, fixable: true });
    }
    checks.push(...(await checkFields({ template: fields }, values, ctx)));
  }

  const verdict = verdictOf({ fields: values, checks });
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const summary =
    verdict === 'invalid'
      ? `No SUBMISSION block found. Copy the block from the bounty and fill in ${fields.map((f) => f.id).join(', ')}.`
      : verdict === 'disqualified'
        ? `This would not be accepted: ${fails.filter((c) => !c.fixable).map((c) => c.message).join('; ')}.`
        : verdict === 'needs-changes'
          ? `Fix ${fails.length === 1 ? 'this' : `these ${fails.length} problems`} before you submit: ${fails.map((c) => c.message).join('; ')}.`
          : warns.length
            ? `Ready to submit. ${warns.length === 1 ? 'One check' : `${warns.length} checks`} could not be verified; make sure ${warns.length === 1 ? 'it is' : 'they are'} right.`
            : 'Ready to submit: every check passed.';

  return {
    rules: opts.template ? 'brief' : 'bounty',
    fields: fields.map((f) => f.id),
    checks,
    verdict,
    ready: verdict === 'eligible',
    summary,
    limits: [
      "Copies are checked against other people's submissions at review time, which a pre-check cannot see.",
      'Passing every check makes a submission eligible; the creator still chooses who wins.',
    ],
  };
}
