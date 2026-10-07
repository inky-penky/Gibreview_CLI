import type { RunState, SubmissionState } from './state.js';
import type { CaseResult } from './parser.js';
import type { TestCase } from './plan.js';

export type CellOutcome = 'PASS' | 'FAIL' | 'DISPUTED' | 'BLOCKED' | 'NOT_RUN';

export interface CellObservation extends CaseResult {
  submissionId: string;
  username: string;
  device: string | null;
}

export interface Cell {
  caseId: string;
  deviceId: string;
  outcome: CellOutcome;
  pass: number;
  fail: number;
  blocked: number;
  observations: CellObservation[];
}

export interface CaseSummary {
  testCase: TestCase;
  outcome: CellOutcome;
  cells: Cell[];
}

export type GateVerdict = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface Aggregate {
  cases: CaseSummary[];
  gate: { verdict: GateVerdict; reasons: string[] };
  totals: { submissions: number; valid: number; incomplete: number; invalid: number; approved: number; rejected: number; paid: string };
}

const SEVERITY: Record<CellOutcome, number> = { FAIL: 4, DISPUTED: 3, BLOCKED: 2, NOT_RUN: 1, PASS: 0 };

/** Submissions whose results we trust enough to count. Spam and rejected work never move the matrix. */
function counted(s: SubmissionState): boolean {
  return s.parsed.verdict !== 'invalid' && s.reviewStatus !== 'rejected';
}

export function aggregate(run: RunState): Aggregate {
  const subs = Object.values(run.submissions);
  const cases: CaseSummary[] = run.plan.cases.map((testCase) => {
    const cells: Cell[] = [];
    for (const batch of run.batches.filter((b) => b.caseIds.includes(testCase.id))) {
      const observations: CellObservation[] = subs
        .filter((s) => s.batchId === batch.id && counted(s))
        .flatMap((s) =>
          s.parsed.results
            .filter((r) => r.caseId === testCase.id)
            .map((r) => ({ ...r, submissionId: s.id, username: s.username, device: s.parsed.device })),
        );
      const pass = observations.filter((o) => o.status === 'PASS').length;
      const fail = observations.filter((o) => o.status === 'FAIL').length;
      const blocked = observations.filter((o) => o.status === 'BLOCKED').length;
      let outcome: CellOutcome;
      if (pass + fail + blocked === 0) outcome = 'NOT_RUN';
      else if (fail > 0 && pass > 0) outcome = 'DISPUTED';
      else if (fail > 0) outcome = 'FAIL';
      else if (pass > 0) outcome = 'PASS';
      else outcome = 'BLOCKED';
      cells.push({ caseId: testCase.id, deviceId: batch.deviceId, outcome, pass, fail, blocked, observations });
    }
    const outcome = cells.reduce<CellOutcome>((worst, c) => (SEVERITY[c.outcome] > SEVERITY[worst] ? c.outcome : worst), 'PASS');
    return { testCase, outcome: cells.length ? outcome : 'NOT_RUN', cells };
  });

  const reasons: string[] = [];
  let verdict: GateVerdict = 'PASS';
  for (const c of cases) {
    for (const cell of c.cells) {
      const device = run.plan.devices.find((d) => d.id === cell.deviceId)?.label ?? cell.deviceId;
      if (run.plan.gate.failOn.includes(c.testCase.priority) && (cell.outcome === 'FAIL' || cell.outcome === 'DISPUTED')) {
        verdict = 'FAIL';
        reasons.push(`${c.testCase.id} [${c.testCase.priority}] ${cell.outcome === 'FAIL' ? 'fails' : 'is disputed'} on ${device} (${cell.fail} fail / ${cell.pass} pass)`);
      }
    }
  }
  if (verdict !== 'FAIL') {
    for (const c of cases) {
      for (const cell of c.cells) {
        const device = run.plan.devices.find((d) => d.id === cell.deviceId)?.label ?? cell.deviceId;
        if (run.plan.gate.requireCoverageOn.includes(c.testCase.priority) && (cell.outcome === 'NOT_RUN' || cell.outcome === 'BLOCKED')) {
          verdict = 'INCOMPLETE';
          reasons.push(`${c.testCase.id} [${c.testCase.priority}] has no usable result on ${device} (${cell.outcome.toLowerCase().replace('_', ' ')})`);
        }
      }
    }
  }
  if (verdict === 'PASS') reasons.push('No blocking failures and every required case has coverage');

  let paidCents = 0;
  for (const s of subs) {
    if (s.decision?.action === 'approve' && s.decision.amount) {
      const [w, f = ''] = s.decision.amount.split('.');
      paidCents += Number(w) * 100 + Number((f + '00').slice(0, 2));
    }
  }

  return {
    cases,
    gate: { verdict, reasons },
    totals: {
      submissions: subs.length,
      valid: subs.filter((s) => s.parsed.verdict === 'valid').length,
      incomplete: subs.filter((s) => s.parsed.verdict === 'incomplete').length,
      invalid: subs.filter((s) => s.parsed.verdict === 'invalid').length,
      approved: subs.filter((s) => s.reviewStatus === 'approved').length,
      rejected: subs.filter((s) => s.reviewStatus === 'rejected').length,
      paid: `${Math.floor(paidCents / 100)}.${String(paidCents % 100).padStart(2, '0')}`,
    },
  };
}
