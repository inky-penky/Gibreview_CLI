import { basename, dirname, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { readCasesCsv, type CsvImportResult } from './csvcases.js';
import { PlanError, validatePlan, type TestPlan } from './plan.js';

export const DEFAULT_DEVICES = [
  { id: 'android-chrome', label: 'Android phone (Chrome)' },
  { id: 'ios-safari', label: 'iPhone (Safari)' },
  { id: 'desktop', label: 'Desktop browser' },
];

export interface ImportOptions {
  csvPath: string;
  outPath: string;
  url: string;
  name?: string;
  release?: string;
  perTester?: string;
  testersPerBatch?: number;
  /** Reference the CSV with casesFile instead of copying cases in, so the spreadsheet stays the source of truth. */
  link?: boolean;
}

export interface ImportResult {
  plan: TestPlan;
  csv: CsvImportResult;
  yaml: string;
}

export async function importCsvPlan(opts: ImportOptions): Promise<ImportResult> {
  const csv = await readCasesCsv(opts.csvPath, DEFAULT_DEVICES);
  if (csv.errors.length) throw new PlanError(`${opts.csvPath} could not be imported`, csv.errors);

  const base = {
    name: opts.name ?? basename(opts.csvPath).replace(/\.(csv|tsv)$/i, '').replace(/[_-]+/g, ' ').trim(),
    ...(opts.release ? { release: opts.release } : {}),
    build: { url: opts.url, notes: 'Add test logins, test card details and anything else testers need here.' },
    reward: { symbol: 'USDC', perTester: opts.perTester ?? '2.00', testersPerBatch: opts.testersPerBatch ?? 2 },
    batchSize: 5,
    deadlineHours: 48,
    tags: ['QA', 'Testing'],
    gate: { failOn: ['high'], requireCoverageOn: ['high'] },
    devices: DEFAULT_DEVICES,
  };
  const casesFile = relative(dirname(resolve(opts.outPath)), resolve(opts.csvPath)) || basename(opts.csvPath);
  const raw = opts.link ? { ...base, casesFile } : { ...base, cases: csv.cases };
  const plan = validatePlan({ ...base, cases: csv.cases });

  const header = [
    `# Imported by "gibreview qa import" from ${basename(opts.csvPath)} (${csv.cases.length} cases)`,
    opts.link
      ? `# Cases are read from ${casesFile} every time you run "gibreview qa plan", so keep editing the spreadsheet.`
      : '# Cases were copied in. Re-run "gibreview qa import" or use --link to keep the spreadsheet as the source of truth.',
    '# Check the reward, build notes and devices below before publishing.',
    '',
  ].join('\n');
  return { plan, csv, yaml: header + stringify(raw, { lineWidth: 110 }) };
}
