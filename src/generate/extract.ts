import { readFile } from 'node:fs/promises';
import { parse, type HTMLElement } from 'node-html-parser';

export interface FieldModel {
  label: string;
  name: string;
  type: string; // text, email, tel, number, password, select, textarea, checkbox, radio, date, url…
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
  options?: string[];
  placeholder?: string;
}

export interface FormModel {
  label: string;
  fields: FieldModel[];
  submitLabel: string | null;
}

export interface PageModel {
  url: string;
  title: string;
  headings: string[];
  forms: FormModel[];
  actions: string[]; // prominent buttons outside forms
  links: Array<{ text: string; href: string }>;
  imagesMissingAlt: number;
  renderedWith: 'browser' | 'fetch' | 'file';
}

export type RenderMode = 'auto' | 'browser' | 'fetch';

export interface LoadOptions {
  url: string;
  htmlFile?: string;
  render?: RenderMode;
  /** Cookie header value, or path to a Playwright storage-state/cookies JSON file for the browser. */
  cookies?: string;
  log?: (m: string) => void;
}

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

async function renderWithBrowser(url: string, cookies?: string): Promise<string | null> {
  let pw: any;
  try {
    // Optional dependency: npm i playwright && npx playwright install chromium
    pw = await import(/* webpackIgnore: true */ 'playwright' as string);
  } catch {
    return null;
  }
  const browser = await pw.chromium.launch();
  try {
    const storageState = cookies && /\.json$/i.test(cookies) ? cookies : undefined;
    const context = await browser.newContext({ storageState });
    if (cookies && !storageState) {
      const host = new URL(url).hostname;
      await context.addCookies(
        cookies.split(';').map((c: string) => {
          const [name, ...rest] = c.trim().split('=');
          return { name, value: rest.join('='), domain: host, path: '/' };
        }),
      );
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function fetchHtml(url: string, cookies?: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'gibreview/0.1 (+test-plan generator)', ...(cookies && !cookies.endsWith('.json') ? { cookie: cookies } : {}) },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetching ${url} failed with HTTP ${res.status}`);
  return await res.text();
}

export async function loadPage(opts: LoadOptions): Promise<PageModel> {
  const log = opts.log ?? (() => {});
  let html: string;
  let renderedWith: PageModel['renderedWith'];
  if (opts.htmlFile) {
    html = await readFile(opts.htmlFile, 'utf8');
    renderedWith = 'file';
  } else {
    const mode = opts.render ?? 'auto';
    let rendered: string | null = null;
    if (mode !== 'fetch') {
      log('Rendering in a headless browser…');
      rendered = await renderWithBrowser(opts.url, opts.cookies);
      if (!rendered && mode === 'browser') {
        throw new Error('Playwright is not installed. Run: npm i playwright && npx playwright install chromium');
      }
      if (!rendered) log('Playwright not installed, falling back to a plain fetch (JavaScript-rendered content will be missed).');
    }
    if (rendered) {
      html = rendered;
      renderedWith = 'browser';
    } else {
      html = await fetchHtml(opts.url, opts.cookies);
      renderedWith = 'fetch';
    }
  }
  return extractModel(html, opts.url, renderedWith);
}

function fieldLabel(root: HTMLElement, el: HTMLElement): string {
  const id = el.getAttribute('id');
  if (id) {
    const lab = root.querySelector(`label[for="${id}"]`);
    if (lab) return clean(lab.text);
  }
  let p: HTMLElement | null = el.parentNode as HTMLElement | null;
  while (p && p.tagName) {
    if (p.tagName === 'LABEL') return clean(p.text);
    p = p.parentNode as HTMLElement | null;
  }
  return clean(el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? id ?? '');
}

const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function extractFields(root: HTMLElement, scope: HTMLElement): FieldModel[] {
  const fields: FieldModel[] = [];
  const seenRadio = new Set<string>();
  for (const el of scope.querySelectorAll('input, select, textarea')) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag;
    if (SKIP_TYPES.has(type)) continue;
    const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
    if (type === 'radio') {
      if (seenRadio.has(name)) {
        fields.find((f) => f.name === name)?.options?.push(fieldLabel(root, el));
        continue;
      }
      seenRadio.add(name);
    }
    const groupLabel = () => {
      let p: HTMLElement | null = el.parentNode as HTMLElement | null;
      while (p && p.tagName) {
        if (p.tagName === 'FIELDSET') {
          const legend = p.querySelector('legend');
          if (legend) return clean(legend.text);
        }
        p = p.parentNode as HTMLElement | null;
      }
      return name.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Option';
    };
    const label = type === 'radio' ? groupLabel() : fieldLabel(root, el).replace(/\*$/, '').trim() || name || type;
    const f: FieldModel = {
      label,
      name,
      type,
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    };
    const minL = num(el.getAttribute('minlength'));
    const maxL = num(el.getAttribute('maxlength'));
    if (minL !== undefined) f.minLength = minL;
    if (maxL !== undefined) f.maxLength = maxL;
    if (el.getAttribute('min')) f.min = el.getAttribute('min');
    if (el.getAttribute('max')) f.max = el.getAttribute('max');
    if (el.getAttribute('pattern')) f.pattern = el.getAttribute('pattern');
    if (el.getAttribute('placeholder')) f.placeholder = clean(el.getAttribute('placeholder'));
    if (tag === 'select') f.options = el.querySelectorAll('option').map((o) => clean(o.text)).filter(Boolean).slice(0, 10);
    if (type === 'radio') f.options = [fieldLabel(root, el)];
    fields.push(f);
  }
  return fields;
}

function buttonText(b: HTMLElement): string {
  return clean(b.tagName === 'INPUT' ? b.getAttribute('value') : b.text || b.getAttribute('aria-label'));
}

export function extractModel(html: string, url: string, renderedWith: PageModel['renderedWith'] = 'file'): PageModel {
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });

  const forms: FormModel[] = root.querySelectorAll('form').map((form, i) => {
    const submit =
      form.querySelector('button[type="submit"], input[type="submit"]') ??
      form.querySelectorAll('button').find((b) => !b.getAttribute('type') || b.getAttribute('type') === 'submit') ??
      null;
    const heading = form.querySelector('h1, h2, h3, h4, legend');
    const submitLabel = submit ? buttonText(submit) || null : null;
    const label =
      clean(form.getAttribute('aria-label') ?? heading?.text ?? '') ||
      (submitLabel ? `${submitLabel} form` : '') ||
      clean(form.getAttribute('name') ?? form.getAttribute('id') ?? '') ||
      `Form ${i + 1}`;
    return { label, fields: extractFields(root, form), submitLabel };
  }).filter((f) => f.fields.length > 0);

  const actions = [
    ...new Set(
      root
        .querySelectorAll('button, [role="button"], a.btn, a.button, input[type="button"]')
        .filter((b) => !b.closest('form') && !b.closest('nav') && !b.closest('footer'))
        .map(buttonText)
        .filter(
          (t) =>
            t.length > 1 &&
            t.length < 40 &&
            !/^(menu|close\b.*|×|x|open menu|toggle|dismiss)$/i.test(t) &&
            // cookie banners and consent prompts are not the feature under test
            !/cookie|consent|personal information|privacy|accept all|reject all/i.test(t),
        ),
    ),
  ].slice(0, 8);

  const base = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  const links = root
    .querySelectorAll('nav a[href], header a[href]')
    .map((a) => ({ text: clean(a.text || a.getAttribute('aria-label')), href: a.getAttribute('href') ?? '' }))
    .filter((l) => l.text && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:'))
    .map((l) => {
      try {
        return { ...l, href: base ? new URL(l.href, base).toString() : l.href };
      } catch {
        return l;
      }
    })
    .filter((l, i, arr) => arr.findIndex((x) => x.href === l.href) === i)
    .slice(0, 8);

  return {
    url,
    title: clean(root.querySelector('title')?.text) || clean(root.querySelector('h1')?.text) || url,
    headings: root.querySelectorAll('h1, h2').map((h) => clean(h.text)).filter(Boolean).slice(0, 10),
    forms,
    actions,
    links,
    imagesMissingAlt: root.querySelectorAll('img').filter((img) => !img.hasAttribute('alt')).length,
    renderedWith,
  };
}
