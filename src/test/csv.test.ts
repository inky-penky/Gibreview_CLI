import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePriority, parseCasesCsv, readCasesCsv, splitSteps, matchDevices } from '../csvcases.js';
import { importCsvPlan, DEFAULT_DEVICES } from '../importplan.js';
import { loadPlanWithInfo, PlanError } from '../plan.js';

const csvDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'csv');

test('priority names from Jira, TestRail, Zephyr and P-levels normalise', () => {
  const table: Array<[string, string | null]> = [
    ['P1', 'high'], ['p2', 'medium'], ['P3', 'low'], ['Critical', 'high'], ['Blocker', 'high'], ['Highest', 'high'],
    ['Major', 'medium'], ['Normal', 'medium'], ['Minor', 'low'], ['Trivial', 'low'],
    ['4 - Must Test', 'high'], ['3 - High', 'high'], ['2 - Medium', 'medium'], ['1 - Low', 'low'], ['S1', 'high'], ['', null], ['banana', null],
  ];
  for (const [raw, want] of table) assert.equal(normalisePriority(raw), want, raw);
});

test('steps split from lines, inline numbering and bullets', () => {
  assert.deepEqual(splitSteps('1. Log in 2. Tap Transfer 3. Confirm'), ['Log in', 'Tap Transfer', 'Confirm']);
  assert.deepEqual(splitSteps('- Add item\n- Pay\r\n'), ['Add item', 'Pay']);
  assert.deepEqual(splitSteps('Step 1: Open app\nStep 2: Tap Pay'), ['Open app', 'Tap Pay']);
  assert.deepEqual(splitSteps('Pay 2 items with the test card'), ['Pay 2 items with the test card']);
});

test('device cells map onto plan devices', () => {
  assert.deepEqual(matchDevices('Mobile', DEFAULT_DEVICES).ids, ['android-chrome', 'ios-safari']);
  assert.deepEqual(matchDevices('Android, iOS', DEFAULT_DEVICES).ids, ['android-chrome', 'ios-safari']);
  assert.deepEqual(matchDevices('Chrome desktop', DEFAULT_DEVICES).ids, ['desktop']);
  assert.deepEqual(matchDevices('All', DEFAULT_DEVICES).ids, []);
  assert.deepEqual(matchDevices('Smart TV', DEFAULT_DEVICES).unknown, ['Smart TV']);
});

test('Google Sheets export with quoted multi-line cells', async () => {
  const r = await readCasesCsv(join(csvDir, 'google-sheets-cases.csv'), DEFAULT_DEVICES);
  assert.deepEqual(r.errors, []);
  assert.equal(r.cases.length, 4);
  assert.equal(r.cases[0].steps[2], 'Choose "Continue as guest" at checkout');
  assert.deepEqual(r.cases[2].devices, ['android-chrome', 'ios-safari']);
  assert.equal(r.cases[0].devices, undefined, '"All" means every device');
  assert.deepEqual(r.ignoredColumns, ['Assignee', 'Status']);
});

test('TestRail one-row-per-step export merges continuation rows', async () => {
  const r = await readCasesCsv(join(csvDir, 'testrail-export.csv'), DEFAULT_DEVICES);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.cases.map((c) => c.id), ['C101', 'C102', 'C103', 'C104']);
  assert.equal(r.cases[0].steps.length, 2);
  assert.match(r.cases[0].expected, /^\(1\) Sign-in form is shown \(2\) Home screen loads/);
  assert.deepEqual(r.cases.map((c) => c.priority), ['high', 'high', 'medium', 'low']);
});

test('Excel semicolon export with BOM and severity column', async () => {
  const r = await readCasesCsv(join(csvDir, 'excel-semicolon.csv'), DEFAULT_DEVICES);
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.errors, []);
  assert.equal(r.cases[0].id, 'TS-001');
  assert.equal(r.cases[0].steps.length, 4);
  assert.deepEqual(r.cases.map((c) => c.priority), ['high', 'medium', 'low']);
});

test('reports row-level problems a person can fix', () => {
  const r = parseCasesCsv('ID,Title,Steps,Expected,Priority\nA1,Login,Open app,Works,urgent-ish\nA1,Dup,Open,Fine,P2\nA3,No expected,Open,,P1\n', DEFAULT_DEVICES);
  assert.ok(r.errors.some((e) => /Row 3: duplicate id A1 \(also on row 2\)/.test(e)));
  assert.ok(r.errors.some((e) => /Row 4 \(A3\): no expected result/.test(e)));
  const r2 = parseCasesCsv('Owner,Status\nAda,Ready\n');
  assert.match(r2.errors[0], /Could not find a title or steps column/);
  const r3 = parseCasesCsv('Title,Steps,Expected,Priority\nLogin,Open app,Works,someday\n');
  assert.equal(r3.cases[0].id, 'TC-01', 'ids are generated when missing');
  assert.ok(r3.warnings.some((w) => /priority "someday" not recognised/.test(w)));
});

test('import writes a valid plan, and --link keeps reading the CSV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugbash-csv-'));
  await copyFile(join(csvDir, 'testrail-export.csv'), join(dir, 'cases.csv'));

  const copied = await importCsvPlan({ csvPath: join(dir, 'cases.csv'), outPath: join(dir, 'a.yaml'), url: 'https://staging.example.com' });
  assert.equal(copied.plan.cases.length, 4);
  await writeFile(join(dir, 'a.yaml'), copied.yaml);
  assert.equal((await loadPlanWithInfo(join(dir, 'a.yaml'))).plan.cases.length, 4);

  const linked = await importCsvPlan({ csvPath: join(dir, 'cases.csv'), outPath: join(dir, 'b.yaml'), url: 'https://staging.example.com', link: true });
  assert.match(linked.yaml, /casesFile: cases.csv/);
  await writeFile(join(dir, 'b.yaml'), linked.yaml);
  const loaded = await loadPlanWithInfo(join(dir, 'b.yaml'));
  assert.equal(loaded.plan.cases.length, 4);

  await assert.rejects(loadPlanWithInfo(join(dir, 'cases.csv')), (e: unknown) => e instanceof PlanError && /bugbash import/.test(e.message));
});
