import { htmlToText } from './content.js';

export type CaseStatus = 'PASS' | 'FAIL' | 'BLOCKED';

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

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses a tester's submission against the case ids the bounty asked for.
 * Tolerant of HTML, bullets, extra whitespace, lowercase statuses and ":" or "-" separators,
 * strict about completeness and evidence, because that is what decides payout.
 */
export function parseSubmission(content: string, expectedCaseIds: string[]): ParsedSubmission {
  const text = /<[a-z][\s\S]*>/i.test(content) ? htmlToText(content) : content;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s+)+/, '').trim());

  let device: string | null = null;
  const byId = new Map<string, CaseResult>();
  const idAlternation = expectedCaseIds.map(escapeRe).join('|');
  const caseRe = new RegExp(`^(${idAlternation})\\s*[:=\\-–]\\s*(pass(?:ed)?|fail(?:ed)?|blocked)\\b\\s*[-–:|]?\\s*(.*)$`, 'i');

  for (const line of lines) {
    const dev = /^device\s*[:\-]\s*(.+)$/i.exec(line);
    if (dev && !dev[1].includes('<phone')) {
      device = dev[1].trim();
      continue;
    }
    const m = caseRe.exec(line);
    if (!m) continue;
    const caseId = expectedCaseIds.find((id) => id.toLowerCase() === m[1].toLowerCase())!;
    const raw = m[2].toUpperCase();
    const status: CaseStatus = raw.startsWith('PASS') ? 'PASS' : raw.startsWith('FAIL') ? 'FAIL' : 'BLOCKED';
    const rest = m[3] ?? '';
    // Template placeholders count as empty.
    const cleaned = rest.replace(/<what happened>|<evidence link>/gi, '').trim();
    const evidence = [...cleaned.matchAll(URL_RE)].map((u) => u[0]);
    const note = cleaned
      .replace(URL_RE, '')
      .split(/\s+[-–|]\s+|\s*\|\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' - ')
      .replace(/^[-–|\s]+|[-–|\s]+$/g, '');
    if (!byId.has(caseId)) byId.set(caseId, { caseId, status, note, evidence });
  }

  const results = expectedCaseIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const issues: string[] = [];

  if (results.length === 0) {
    return { device, results, verdict: 'invalid', issues: ['No result block found. Use the BUGBASH RESULT template from the bounty.'] };
  }

  const missing = expectedCaseIds.filter((id) => !byId.has(id));
  if (missing.length) issues.push(`Missing results for ${missing.join(', ')}`);
  if (!device) issues.push('Device line is missing or still the placeholder');
  for (const r of results) {
    if (r.status === 'FAIL' && r.evidence.length === 0) issues.push(`${r.caseId} is FAIL without an evidence link`);
    if (r.status === 'FAIL' && !r.note) issues.push(`${r.caseId} is FAIL without a description`);
    if (r.status === 'BLOCKED' && !r.note) issues.push(`${r.caseId} is BLOCKED without a reason`);
  }

  return { device, results, verdict: issues.length ? 'incomplete' : 'valid', issues };
}
