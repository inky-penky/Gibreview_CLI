/**
 * Submission templates: the block a bounty asks participants to fill in, and a tolerant parser for it.
 * Generic over bounty types. A preset (QA today; dev and content next) defines the fields, and adds
 * its own rules on top of what this layer reports.
 *
 *   QA RESULT                 <- header (optional when parsing)
 *   Device: <phone model…>         <- text field
 *   TC-01: PASS | FAIL | BLOCKED…  <- case-result field
 *   END                            <- footer (optional when parsing)
 */

export type FieldType = 'text' | 'url' | 'case-result';
export type CaseStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface TemplateField {
  /** What the participant types before the separator. Matched case-insensitively. */
  key: string;
  type: FieldType;
  /** Shown after the key in the rendered template. Any <angle bracket> token in it counts as "not filled in". */
  placeholder?: string;
  /** Defaults to true. */
  required?: boolean;
}

export interface Template {
  header: string;
  footer: string;
  fields: TemplateField[];
}

export interface ParsedField {
  key: string;
  /** Value as typed, after the separator. */
  raw: string;
  /** Value with placeholder tokens removed. Empty means not filled in. */
  text: string;
  urls: string[];
  /** case-result only. */
  status?: CaseStatus;
  /** case-result only: the description with links and separators removed. */
  note?: string;
}

export interface ParsedTemplate {
  /** Answered fields by key, in template order. The first answer for a key wins. */
  fields: Map<string, ParsedField>;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDER_RE = /<[^<>]+>/g;

export function renderTemplate(t: Template): string {
  return [t.header, ...t.fields.map((f) => `${f.key}: ${f.placeholder ?? `<${f.key.toLowerCase()}>`}`), t.footer].join('\n');
}

function stripPlaceholders(value: string, field: TemplateField): string {
  let out = value;
  for (const token of field.placeholder?.match(PLACEHOLDER_RE) ?? []) out = out.replace(new RegExp(escapeRe(token), 'gi'), '');
  return out.trim();
}

const CASE_RE = /^(pass(?:ed)?|fail(?:ed)?|blocked)\b\s*[-–:|]?\s*(.*)$/i;

function parseCaseResult(value: string, field: TemplateField): Pick<ParsedField, 'status' | 'note' | 'text' | 'urls'> | null {
  const m = CASE_RE.exec(value);
  if (!m) return null;
  const word = m[1].toUpperCase();
  const status: CaseStatus = word.startsWith('PASS') ? 'PASS' : word.startsWith('FAIL') ? 'FAIL' : 'BLOCKED';
  const text = stripPlaceholders(m[2] ?? '', field);
  const urls = [...text.matchAll(URL_RE)].map((u) => u[0]);
  const note = text
    .replace(URL_RE, '')
    .split(/\s+[-–|]\s+|\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' - ')
    .replace(/^[-–|\s]+|[-–|\s]+$/g, '');
  return { status, note, text, urls };
}

/**
 * Tolerant of HTML, bullets, numbering, extra whitespace, any key casing and ":", "=", "-" or "–"
 * separators, because participants paste from many apps. The header and footer are optional.
 * Lines whose key is not in the template are ignored.
 */
export function parseTemplate(content: string, t: Template): ParsedTemplate {
  const text = /<[a-z][\s\S]*>/i.test(content) ? htmlToText(content) : content;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s+)+/, '').trim());
  const byKey = new Map(t.fields.map((f) => [f.key.toLowerCase(), f]));
  const lineRe = new RegExp(`^(${t.fields.map((f) => escapeRe(f.key)).join('|')})\\s*[:=\\-–]\\s*(.*)$`, 'i');

  const found = new Map<string, ParsedField>();
  for (const line of lines) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const field = byKey.get(m[1].toLowerCase())!;
    if (found.has(field.key)) continue;
    const raw = m[2] ?? '';
    if (field.type === 'case-result') {
      const parsed = parseCaseResult(raw, field);
      if (parsed) found.set(field.key, { key: field.key, raw, ...parsed });
      continue;
    }
    const value = stripPlaceholders(raw, field);
    if (!value) continue; // still the placeholder: keep looking for a filled-in line
    found.set(field.key, { key: field.key, raw, text: value, urls: [...value.matchAll(URL_RE)].map((u) => u[0]) });
  }

  // Template order, so callers get a stable result whatever order the participant used.
  return { fields: new Map(t.fields.filter((f) => found.has(f.key)).map((f) => [f.key, found.get(f.key)!])) };
}

/** Required fields that are missing or not filled in. A url field needs at least one link. */
export function missingFields(t: Template, parsed: ParsedTemplate): TemplateField[] {
  return t.fields.filter((f) => {
    if (f.required === false) return false;
    const v = parsed.fields.get(f.key);
    if (!v) return true;
    return f.type === 'url' ? v.urls.length === 0 : false;
  });
}

/** Plain text view of HTML from Gibwork (bounty content, submissions) for parsing and terminal previews. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n  - ')
    .replace(/<\/(p|div|h\d|pre|ol|ul|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
