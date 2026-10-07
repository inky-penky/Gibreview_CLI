import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmission } from '../parser.js';

const ids = ['TC-01', 'TC-02', 'TC-03'];

test('parses a clean plain-text result block', () => {
  const p = parseSubmission(
    ['BUGBASH RESULT', 'Device: Pixel 7, Android 14, Chrome 129', 'TC-01: PASS', 'TC-02: FAIL - Pay button greyed out - https://x.example/v.mp4', 'TC-03: BLOCKED - staging down', 'END'].join('\n'),
    ids,
  );
  assert.equal(p.verdict, 'valid');
  assert.equal(p.device, 'Pixel 7, Android 14, Chrome 129');
  assert.deepEqual(p.results.map((r) => r.status), ['PASS', 'FAIL', 'BLOCKED']);
  assert.equal(p.results[1].note, 'Pay button greyed out');
  assert.deepEqual(p.results[1].evidence, ['https://x.example/v.mp4']);
});

test('tolerates HTML, bullets, lowercase and alternative separators', () => {
  const p = parseSubmission(
    '<p>device - iPhone 13 iOS 17</p><ul><li>tc-01 = passed</li><li>TC-02 – failed | crash on submit | https://imgur.example/a.png</li><li>3. TC-03: Pass</li></ul>',
    ids,
  );
  assert.equal(p.verdict, 'valid');
  assert.deepEqual(p.results.map((r) => [r.caseId, r.status]), [['TC-01', 'PASS'], ['TC-02', 'FAIL'], ['TC-03', 'PASS']]);
  assert.equal(p.results[1].note, 'crash on submit');
});

test('flags missing cases, missing evidence and placeholder device as incomplete', () => {
  const p = parseSubmission(
    ['Device: <phone or computer model, OS version, browser and version>', 'TC-01: PASS', 'TC-02: FAIL - <what happened> - <evidence link>'].join('\n'),
    ids,
  );
  assert.equal(p.verdict, 'incomplete');
  assert.equal(p.device, null);
  assert.ok(p.issues.some((i) => i.includes('TC-03')));
  assert.ok(p.issues.some((i) => i.includes('TC-02 is FAIL without an evidence link')));
  assert.ok(p.issues.some((i) => i.includes('TC-02 is FAIL without a description')));
  assert.ok(p.issues.some((i) => i.includes('Device line')));
});

test('spam with no result block is invalid', () => {
  const p = parseSubmission('<p>Tested everything, all good, please approve</p>', ids);
  assert.equal(p.verdict, 'invalid');
  assert.equal(p.results.length, 0);
});

test('ignores ids that were not asked for and keeps the first answer per case', () => {
  const p = parseSubmission(['Device: X', 'TC-01: PASS', 'TC-01: FAIL - changed my mind - https://a.example', 'TC-99: PASS', 'TC-02: PASS', 'TC-03: PASS'].join('\n'), ids);
  assert.equal(p.results.length, 3);
  assert.equal(p.results[0].status, 'PASS');
});
