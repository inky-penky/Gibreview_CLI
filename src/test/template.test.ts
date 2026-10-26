import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingFields, parseTemplate, renderTemplate, type Template } from '../template.js';

const content: Template = {
  header: 'SUBMISSION',
  footer: 'END',
  fields: [
    { key: 'link', type: 'url', placeholder: '<link to your guide>' },
    { key: 'summary', type: 'text', placeholder: '<one paragraph>' },
    { key: 'twitter', type: 'text', required: false },
  ],
};

test('renders fields in order, with a default placeholder when none is given', () => {
  assert.equal(renderTemplate(content), ['SUBMISSION', 'link: <link to your guide>', 'summary: <one paragraph>', 'twitter: <twitter>', 'END'].join('\n'));
});

test('parses text and url fields, with or without the header and footer', () => {
  const body = 'link: https://dev.to/ada/guide\nsummary: A beginner guide to the three endpoints.';
  for (const input of [body, `SUBMISSION\n${body}\nEND`]) {
    const p = parseTemplate(input, content);
    assert.deepEqual([...p.fields.keys()], ['link', 'summary']);
    assert.deepEqual(p.fields.get('link')!.urls, ['https://dev.to/ada/guide']);
    assert.equal(p.fields.get('summary')!.text, 'A beginner guide to the three endpoints.');
    assert.deepEqual(missingFields(content, p), []);
  }
});

test('placeholders count as not filled in, and a later filled-in line still counts', () => {
  const p = parseTemplate('link: <link to your guide>\nsummary: <one paragraph>\nlink: https://a.example/x', content);
  assert.deepEqual(p.fields.get('link')!.urls, ['https://a.example/x']);
  assert.deepEqual(missingFields(content, p).map((f) => f.key), ['summary']);
});

test('a url field without a link is missing, optional fields never are', () => {
  const p = parseTemplate('link: on my blog\nsummary: Done.', content);
  assert.deepEqual(missingFields(content, p).map((f) => f.key), ['link']);
});

test('tolerates HTML, bullets, key casing and separators, keeps the first answer and returns template order', () => {
  const p = parseTemplate('<ul><li>SUMMARY = first answer</li><li>Summary - second answer</li><li>LINK – https://b.example/y</li></ul>', content);
  assert.deepEqual([...p.fields.keys()], ['link', 'summary']);
  assert.equal(p.fields.get('summary')!.text, 'first answer');
});

test('ignores keys that are not in the template and text that only mentions one', () => {
  const p = parseTemplate('notes: hi\nMy link: https://c.example\nsummary of work: nope', content);
  assert.equal(p.fields.size, 0);
});
