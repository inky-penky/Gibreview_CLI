import { missingFields, parseTemplate, type CaseStatus, type Template } from './template.js';

export type { CaseStatus };

export interface CaseResult {
  caseId: string;
  status: CaseStatus;
  note: string;
  evidence: string[];
}

export type Verdict = 'valid' | 'incomplete' | 'invalid';

export interface ParsedSubmission {
  device: string | null;
  results: CaseResult[];
  verdict: Verdict;
  issues: string[];
}

export const RESULT_HEADER = 'QA RESULT';
export const RESULT_FOOTER = 'END';
const DEVICE_KEY = 'Device';

/** The QA preset's submission template: a device line and one result line per case the bounty asked for. */
export function qaTemplate(caseIds: string[]): Template {
  return {
    header: RESULT_HEADER,
    footer: RESULT_FOOTER,
    fields: [
      { key: DEVICE_KEY, type: 'text', placeholder: '<phone or computer model, OS version, browser and version>' },
      ...caseIds.map((id) => ({ key: id, type: 'case-result' as const, placeholder: 'PASS | FAIL | BLOCKED - <what happened> - <evidence link>' })),
    ],
  };
}

/**
 * Parses a tester's submission against the case ids the bounty asked for.
 * Parsing tolerance comes from the template layer; this adds the QA rules that decide payout:
 * every case answered, a description and evidence link for every FAIL, a reason for every BLOCKED.
 */
export function parseSubmission(content: string, expectedCaseIds: string[]): ParsedSubmission {
  const template = qaTemplate(expectedCaseIds);
  const parsed = parseTemplate(content, template);

  const device = parsed.fields.get(DEVICE_KEY)?.text ?? null;
  const results: CaseResult[] = expectedCaseIds
    .map((id) => parsed.fields.get(id))
    .filter((f) => f !== undefined)
    .map((f) => ({ caseId: f.key, status: f.status!, note: f.note ?? '', evidence: f.urls }));

  if (results.length === 0) {
    return { device, results, verdict: 'invalid', issues: ['No result block found. Use the QA RESULT template from the bounty.'] };
  }

  const issues: string[] = [];
  const missing = missingFields(template, parsed);
  const missingCases = missing.filter((f) => f.type === 'case-result').map((f) => f.key);
  if (missingCases.length) issues.push(`Missing results for ${missingCases.join(', ')}`);
  if (missing.some((f) => f.key === DEVICE_KEY)) issues.push('Device line is missing or still the placeholder');
  for (const r of results) {
    if (r.status === 'FAIL' && r.evidence.length === 0) issues.push(`${r.caseId} is FAIL without an evidence link`);
    if (r.status === 'FAIL' && !r.note) issues.push(`${r.caseId} is FAIL without a description`);
    if (r.status === 'BLOCKED' && !r.note) issues.push(`${r.caseId} is BLOCKED without a reason`);
  }

  return { device, results, verdict: issues.length ? 'incomplete' : 'valid', issues };
}
