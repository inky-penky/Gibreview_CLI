import type { FieldModel, FormModel, PageModel } from './extract.js';

export interface DraftCase {
  title: string;
  priority: 'high' | 'medium' | 'low';
  preconditions?: string;
  steps: string[];
  expected: string;
  devices?: string[];
  reviewNote?: string;
}

const q = (s: string) => `"${s}"`;
const PAYMENTISH = /\b(pay|order|checkout|place|buy|purchase|book|donate|transfer|send|confirm)\b/i;

/** A concrete valid value a tester can type, derived from the field's own constraints. */
function validInput(f: FieldModel): string {
  const L = q(f.label);
  switch (f.type) {
    case 'email':
      return `Enter a valid email address in ${L}`;
    case 'tel':
      return `Enter a valid phone number in ${L}${f.placeholder ? `, for example ${f.placeholder}` : ''}`;
    case 'number':
      return `Set ${L} to a value${f.min && f.max ? ` between ${f.min} and ${f.max}` : f.min ? ` of at least ${f.min}` : f.max ? ` of at most ${f.max}` : ''}`;
    case 'select': {
      const real = (f.options ?? []).filter((o) => !/^(choose|select|--|pick)/i.test(o));
      return `Choose an option in ${L}${real.length ? `, for example ${real[0]}` : ''}`;
    }
    case 'radio':
      return `Choose one ${L} option${f.options?.length ? ` (${f.options.join(' or ')})` : ''}`;
    case 'checkbox':
      return `Tick ${L}`;
    case 'password':
      return `Enter a valid password in ${L} (for a login, use the test account from the build notes)`;
    case 'date':
      return `Pick a valid date in ${L}`;
    case 'url':
      return `Enter a full web address in ${L}, for example https://example.com`;
    default: {
      const len = f.minLength && f.maxLength ? ` (${f.minLength} to ${f.maxLength} characters)` : f.minLength ? ` (at least ${f.minLength} characters)` : '';
      return `Enter a realistic value in ${L}${len}`;
    }
  }
}

function fillRequired(form: FormModel, except?: FieldModel): string {
  const others = form.fields.filter((f) => f.required && f !== except).map((f) => f.label);
  return others.length ? `Fill every other required field validly (${others.join(', ')})` : 'Leave the other fields as they are';
}

function submitStep(form: FormModel): string {
  return form.submitLabel ? `Tap ${q(form.submitLabel)}` : 'Submit the form';
}

function formCases(page: PageModel, form: FormModel, primary: boolean): DraftCase[] {
  const cases: DraftCase[] = [];
  const where = page.forms.length > 1 ? ` in the ${q(form.label)} form` : '';
  const paymentish = PAYMENTISH.test(`${form.submitLabel ?? ''} ${form.label}`);

  cases.push({
    title: `${form.label}: submit with valid details`,
    priority: primary ? 'high' : 'medium',
    steps: [
      `Open ${page.url}`,
      ...form.fields.filter((f) => f.required).map(validInput),
      ...(form.fields.some((f) => !f.required) ? ['Leave optional fields as they are'] : []),
      submitStep(form),
    ],
    expected: paymentish
      ? 'The form submits without errors and you reach the confirmation or payment step for this action'
      : 'The form submits without errors and a success message or the next page appears',
    reviewNote: 'Replace the generic expected result with the exact success message or page the team expects',
  });

  const required = form.fields.filter((f) => f.required);
  if (required.length) {
    cases.push({
      title: `${form.label}: required fields are enforced`,
      priority: primary ? 'high' : 'medium',
      steps: [`Open ${page.url}`, `Leave every field empty${where}`, submitStep(form)],
      expected: `Submission is blocked and each required field shows a clear message (${required.map((f) => f.label).join(', ')})`,
    });
  }

  const v: DraftCase[] = [];
  for (const f of form.fields) {
    const L = q(f.label);
    if (f.type === 'email') {
      v.push({
        title: `${form.label}: invalid email is rejected`,
        priority: 'medium',
        steps: [`Open ${page.url}`, `Enter ada@ in ${L}`, fillRequired(form, f), submitStep(form)],
        expected: `${L} shows an invalid email message and nothing is submitted`,
      });
    } else if (f.type === 'tel' || /phone|mobile/i.test(f.label)) {
      v.push({
        title: `${form.label}: invalid phone number is rejected`,
        priority: 'medium',
        steps: [`Open ${page.url}`, `Enter 0801 (too short) in ${L}`, fillRequired(form, f), submitStep(form), `Now enter letters, for example abcdefghijk, and submit again`],
        expected: `Both attempts are blocked with a clear message under ${L}`,
      });
    } else if (f.type === 'number' && (f.min || f.max)) {
      const tries = [f.min ? `${Number(f.min) - 1} (below the minimum)` : null, f.max ? `${Number(f.max) + 1} (above the maximum)` : null].filter(Boolean);
      v.push({
        title: `${form.label}: ${f.label} limits are enforced`,
        priority: 'medium',
        steps: [`Open ${page.url}`, `Enter ${tries.join(', then ')} in ${L}`, fillRequired(form, f), submitStep(form)],
        expected: `Out-of-range values are rejected or corrected, and the allowed range${f.min && f.max ? ` ${f.min} to ${f.max}` : ''} is clear`,
      });
    } else if (f.minLength && f.minLength > 1) {
      v.push({
        title: `${form.label}: ${f.label} too short`,
        priority: 'low',
        steps: [`Open ${page.url}`, `Enter ${'a'.repeat(f.minLength - 1)} (${f.minLength - 1} characters) in ${L}`, fillRequired(form, f), submitStep(form)],
        expected: `${L} explains it needs at least ${f.minLength} characters and nothing is submitted`,
      });
    } else if (f.maxLength && f.maxLength >= 4 && f.type === 'text') {
      v.push({
        title: `${form.label}: ${f.label} length limit`,
        priority: 'low',
        steps: [`Open ${page.url}`, `Type or paste more than ${f.maxLength} characters into ${L}`],
        expected: `${L} stops at ${f.maxLength} characters or shows a clear limit message, and the layout does not break`,
      });
    } else if (f.type === 'checkbox' && f.required) {
      v.push({
        title: `${form.label}: ${f.label} must be ticked`,
        priority: 'medium',
        steps: [`Open ${page.url}`, fillRequired(form, f), `Leave ${L} unticked`, submitStep(form)],
        expected: `Submission is blocked and you are told to tick ${L}`,
      });
    }
    if (/coupon|promo|voucher|discount/i.test(f.label)) {
      v.push({
        title: `${form.label}: invalid ${f.label.toLowerCase()} is handled`,
        priority: 'medium',
        steps: [`Open ${page.url}`, `Enter NOTREAL123 in ${L} and apply it`],
        expected: 'A clear "invalid code" message appears, the total does not change and you can still complete the order',
      });
    }
  }
  // Validation on secondary forms (newsletter, search) matters less than the main task.
  cases.push(...(primary ? v : v.map((c) => ({ ...c, priority: 'low' as const }))));

  if (paymentish && primary) {
    cases.push({
      title: `${form.label}: double tap does not submit twice`,
      priority: 'high',
      preconditions: 'Use test payment details only',
      steps: [`Open ${page.url}`, ...form.fields.filter((f) => f.required).map(validInput), `Tap ${q(form.submitLabel ?? 'Submit')} twice quickly`],
      expected: 'The button disables or shows a loading state after the first tap, and only one order or charge is created',
      reviewNote: 'Say where testers can confirm a single order was created, for example the orders page',
    });
  }
  return cases;
}

export function rulesCases(page: PageModel): DraftCase[] {
  const cases: DraftCase[] = [];
  const h1 = page.headings[0];

  cases.push({
    title: `${page.title}: page loads correctly`,
    priority: 'high',
    steps: [`Open ${page.url}`, 'Wait for the page to finish loading'],
    expected: `${h1 ? `The ${q(h1)} heading and main content are visible` : 'The main content is visible'}, nothing is broken or overlapping, and no error message appears`,
  });

  const forms = [...page.forms].sort((a, b) => b.fields.length - a.fields.length);
  forms.forEach((f, i) => cases.push(...formCases(page, f, i === 0)));

  for (const action of page.actions.slice(0, 3)) {
    cases.push({
      title: `${q(action)} works`,
      priority: 'medium',
      steps: [`Open ${page.url}`, `Tap ${q(action)}`],
      expected: `Tapping ${q(action)} gives a visible result without an error`,
      reviewNote: `Describe exactly what ${q(action)} should do`,
    });
  }

  if (page.links.length) {
    cases.push({
      title: 'Header and navigation links work',
      priority: 'low',
      steps: [`Open ${page.url}`, `Tap each of these links and come back: ${page.links.map((l) => l.text).join(', ')}`],
      expected: 'Each link opens the right page with no error or "page not found"',
    });
  }

  cases.push({
    title: 'Layout works on a phone screen',
    priority: 'medium',
    devices: ['android-chrome', 'ios-safari'],
    steps: [`Open ${page.url} on your phone`, 'Scroll through the whole page in portrait, then rotate to landscape'],
    expected: 'No sideways scrolling, text is readable without zooming and every button is easy to tap',
  });

  if (forms.length) {
    cases.push({
      title: `${forms[0].label}: keyboard only`,
      priority: 'low',
      devices: ['desktop'],
      steps: [`Open ${page.url}`, 'Without using the mouse, use Tab, Shift+Tab, Enter and Space to fill and submit the form'],
      expected: `Every field and button is reachable, the focus outline is always visible and the form submits${page.imagesMissingAlt ? `. Also note that ${page.imagesMissingAlt} image(s) on the page have no alt text` : ''}`,
    });
  }

  return cases;
}
