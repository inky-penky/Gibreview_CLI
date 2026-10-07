import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

/**
 * Reads test cases from CSV/TSV exports of Excel, Google Sheets, TestRail, Zephyr, Xray, Qase and
 * hand-made sheets. Column names are matched loosely, priorities are normalised, steps can be one
 * cell (numbered or one per line) or one row per step.
 */

export interface CsvCase {
  id: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  preconditions?: string;
  steps: string[];
  expected: string;
  devices?: string[];
}

export interface CsvImportResult {
  cases: CsvCase[];
  columns: Record<string, string | null>;
  ignoredColumns: string[];
  warnings: string[];
  errors: string[];
  delimiter: string;
}

type Field = 'id' | 'title' | 'priority' | 'preconditions' | 'steps' | 'expected' | 'devices';

const ALIASES: Record<Field, string[]> = {
  id: ['id', 'case id', 'test case id', 'testcase id', 'tc id', 'tc', 'test id', 'key', 'issue key', 'test key', 'case no', 'test case no', 's/n', 'no'],
  title: ['title', 'name', 'summary', 'test case', 'test case name', 'test case title', 'testcase', 'test name', 'scenario', 'test scenario', 'description', 'objective'],
  priority: ['priority', 'severity', 'importance', 'criticality', 'risk'],
  preconditions: ['preconditions', 'precondition', 'pre-conditions', 'pre-condition', 'pre conditions', 'prerequisites', 'prerequisite', 'setup', 'pre-requisites', 'test data'],
  steps: ['steps', 'step', 'test steps', 'steps to reproduce', 'actions', 'action', 'procedure', 'step description', 'step action', 'test procedure', 'steps (step)'],
  expected: ['expected', 'expected result', 'expected results', 'expected outcome', 'expected behaviour', 'expected behavior', 'expected output', 'steps (expected result)', 'step expected result'],
  devices: ['devices', 'device', 'platform', 'platforms', 'environment', 'browser', 'browsers', 'os'],
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, ' ').replace(/[^a-z0-9/ ()-]/g, '').trim();

function mapColumns(headers: string[]): Record<Field, number | null> {
  const n = headers.map(norm);
  const out = {} as Record<Field, number | null>;
  const taken = new Set<number>();
  // Exact alias matches first, then "contains" matches, so "Expected Result" never lands in title.
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of Object.keys(ALIASES) as Field[]) {
      if (out[field] != null) continue;
      const idx = n.findIndex((h, i) => !taken.has(i) && ALIASES[field].some((a) => (pass === 'exact' ? h === a : h.includes(a) && a.length > 3)));
      if (idx >= 0) {
        out[field] = idx;
        taken.add(idx);
      }
    }
  }
  for (const f of Object.keys(ALIASES) as Field[]) out[f] ??= null;
  return out;
}

export function normalisePriority(raw: string | undefined): 'high' | 'medium' | 'low' | null {
  const v = (raw ?? '').toLowerCase().trim();
  if (!v) return null;
  // Words win over numbers: TestRail's "1 - Low" and "4 - Must Test" use numbers the opposite way to P1/P2.
  if (/\b(critical|blocker|highest|high|urgent|must|showstopper)\b/.test(v)) return 'high';
  if (/\b(medium|normal|moderate|major|should|default)\b/.test(v)) return 'medium';
  if (/\b(low|lowest|minor|trivial|could|nice|cosmetic)\b/.test(v)) return 'low';
  if (/^(p0|p1|sev ?1|s1)\b/.test(v)) return 'high';
  if (/^(p2|sev ?2|s2)\b/.test(v)) return 'medium';
  if (/^(p[3-5]|sev ?[3-5]|s[3-5])\b/.test(v)) return 'low';
  return null;
}

/** "1. Open app 2. Tap pay" / one per line / bullets → clean step list. */
export function splitSteps(cell: string): string[] {
  const text = cell.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  let parts = text.split('\n');
  if (parts.length === 1) {
    const numbered = text.split(/\s*(?:^|\s)(?:step\s*)?\d{1,2}[.):]\s+/i).filter(Boolean);
    if (numbered.length > 1) parts = numbered;
  }
  return parts.map((p) => p.replace(/^\s*(?:step\s*\d+\s*[:.)-]?|\d{1,2}[.):]|[-*•>])\s*/i, '').trim()).filter(Boolean);
}

function slugId(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '-').replace(/[^\w.-]/g, '');
  return /^[A-Za-z0-9]/.test(s) ? s : `TC-${s.replace(/^[^A-Za-z0-9]+/, '')}`;
}

export interface DeviceRef {
  id: string;
  label: string;
}

/** Maps "Android, iOS" or "Mobile" to plan device ids by id or label keywords. */
export function matchDevices(cell: string, devices: DeviceRef[]): { ids: string[]; unknown: string[] } {
  const ids = new Set<string>();
  const unknown: string[] = [];
  const tokens = cell.split(/[,;/|\n]+/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    const tl = t.toLowerCase();
    if (/^(all|any|every|cross[- ]?platform)$/.test(tl)) return { ids: [], unknown: [] };
    const hits = devices.filter((d) => {
      const hay = `${d.id} ${d.label}`.toLowerCase();
      if (hay.includes(tl)) return true;
      if (/mobile|phone/.test(tl)) return /android|ios|iphone|phone|mobile/.test(hay);
      if (/iphone|ios|safari|apple/.test(tl)) return /ios|iphone|safari/.test(hay);
      if (/android|chrome mobile/.test(tl)) return /android/.test(hay);
      if (/desktop|web|laptop|pc|mac|windows|chrome|firefox|edge/.test(tl)) return /desktop|laptop|web/.test(hay);
      return false;
    });
    if (hits.length) hits.forEach((h) => ids.add(h.id));
    else unknown.push(t);
  }
  return { ids: [...ids], unknown };
}

export function parseCasesCsv(text: string, devices: DeviceRef[] = []): CsvImportResult {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];

  const rows: string[][] = parse(clean, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: false });
  const result: CsvImportResult = { cases: [], columns: {}, ignoredColumns: [], warnings: [], errors: [], delimiter };
  if (rows.length < 2) {
    result.errors.push('The CSV needs a header row and at least one test case row.');
    return result;
  }
  const headers = rows[0].map((h) => h.trim());
  const col = mapColumns(headers);
  for (const f of Object.keys(col) as Field[]) result.columns[f] = col[f] != null ? headers[col[f]!] : null;
  const used = new Set(Object.values(col).filter((v): v is number => v != null));
  result.ignoredColumns = headers.filter((h, i) => h && !used.has(i));

  if (col.title == null && col.steps == null) {
    result.errors.push(`Could not find a title or steps column. Headers seen: ${headers.join(', ')}. Name a column "Title" and one "Steps".`);
    return result;
  }
  if (col.expected == null) result.warnings.push('No expected result column found. Every case needs one, so add an "Expected Result" column.');

  const get = (r: string[], f: Field) => (col[f] != null ? (r[col[f]!] ?? '').trim() : '');
  type Building = CsvCase & { row: number; expectedParts: string[] };
  const out: Building[] = [];
  let auto = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1; // as shown in a spreadsheet, header is row 1
    if (r.every((c) => !c.trim())) continue;
    const id = get(r, 'id');
    const title = get(r, 'title');
    const stepCell = get(r, 'steps');
    const expectedCell = get(r, 'expected');

    // Continuation row (TestRail/Xray "one row per step" exports): no id and no title, only step/expected.
    if (!id && !title && out.length && (stepCell || expectedCell)) {
      const prev = out[out.length - 1];
      prev.steps.push(...splitSteps(stepCell));
      if (expectedCell) prev.expectedParts.push(expectedCell);
      continue;
    }
    if (!title && !stepCell) {
      result.warnings.push(`Row ${rowNo}: skipped, no title or steps`);
      continue;
    }

    const pRaw = get(r, 'priority');
    let priority = normalisePriority(pRaw);
    if (!priority) {
      if (pRaw) result.warnings.push(`Row ${rowNo}: priority "${pRaw}" not recognised, using medium`);
      priority = 'medium';
    }
    const c: Building = {
      row: rowNo,
      id: id ? slugId(id) : `TC-${String(++auto).padStart(2, '0')}`,
      title: title || splitSteps(stepCell)[0] || `Case from row ${rowNo}`,
      priority,
      steps: splitSteps(stepCell),
      expected: '',
      expectedParts: expectedCell ? [expectedCell] : [],
    };
    const pre = get(r, 'preconditions');
    if (pre) c.preconditions = pre.replace(/\s*\n\s*/g, '. ');
    const devCell = get(r, 'devices');
    if (devCell && devices.length) {
      const m = matchDevices(devCell, devices);
      if (m.ids.length) c.devices = m.ids;
      if (m.unknown.length) result.warnings.push(`Row ${rowNo}: device "${m.unknown.join(', ')}" does not match any plan device, case runs on all devices`);
    }
    out.push(c);
  }

  const seen = new Map<string, number>();
  for (const c of out) {
    c.expected = c.expectedParts.length > 1 ? c.expectedParts.map((e, i) => `(${i + 1}) ${e}`).join(' ') : (c.expectedParts[0] ?? '').replace(/\s*\n\s*/g, '. ');
    if (!c.steps.length) result.errors.push(`Row ${c.row} (${c.id}): no steps`);
    if (!c.expected) result.errors.push(`Row ${c.row} (${c.id}): no expected result`);
    if (seen.has(c.id)) result.errors.push(`Row ${c.row}: duplicate id ${c.id} (also on row ${seen.get(c.id)})`);
    else seen.set(c.id, c.row);
  }
  result.cases = out.map(({ row: _r, expectedParts: _e, ...rest }) => rest);
  return result;
}

export async function readCasesCsv(path: string, devices: DeviceRef[] = []): Promise<CsvImportResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { cases: [], columns: {}, ignoredColumns: [], warnings: [], errors: [`Cannot read ${path}`], delimiter: ',' };
  }
  return parseCasesCsv(text, devices);
}
