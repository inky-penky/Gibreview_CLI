import type { Brief, BriefField, CheckSpec } from './brief.js';

/**
 * Automated checks on one submission's fields, plus cross-submission checks (duplicates).
 * A check never guesses against the participant: when a site cannot be reached or rate-limits us,
 * the result is a warning ("unverified"), not a failure.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  field?: string;
  status: CheckStatus;
  message: string;
  /** A failure the participant can fix (dead link, short text). Non-fixable failures disqualify. */
  fixable: boolean;
}

export interface FieldValue {
  text: string;
  urls: string[];
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** Page text, used only by the AI scorer. */
  text?(): Promise<string>;
  body?: { cancel(): Promise<void> } | null;
}>;

export interface CheckContext {
  fetch: FetchLike;
  githubToken?: string;
  timeoutMs?: number;
}

const pass = (id: string, field: string, message: string): CheckResult => ({ id, field, status: 'pass', message, fixable: false });
const warn = (id: string, field: string, message: string): CheckResult => ({ id, field, status: 'warn', message, fixable: false });
const fail = (id: string, field: string, message: string, fixable = true): CheckResult => ({ id, field, status: 'fail', message, fixable });

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

async function get(ctx: CheckContext, url: string, headers: Record<string, string> = {}) {
  const res = await ctx.fetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'gibreview/0.1', ...headers }, signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000) });
  return res;
}

async function reachable(field: string, url: string, ctx: CheckContext): Promise<CheckResult> {
  try {
    const res = await get(ctx, url);
    await res.body?.cancel().catch(() => {}); // only the status matters, never download the page
    if (res.ok) return pass('reachable', field, `${url} opens`);
    if (res.status === 404 || res.status === 410) return fail('reachable', field, `${url} returns ${res.status} (page not found)`);
    return warn('reachable', field, `could not verify ${url} (HTTP ${res.status})`);
  } catch (err) {
    return warn('reachable', field, `could not verify ${url} (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'})`);
  }
}

function domain(field: string, url: string, allowed: string[]): CheckResult {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return fail('domain', field, `${url} is not a valid link`);
  }
  const ok = allowed.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  return ok ? pass('domain', field, `${host} is allowed`) : fail('domain', field, `${host} is not one of ${allowed.join(', ')}`);
}

const PR_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

async function github(field: string, url: string, spec: { repo?: string; requireCi: boolean }, ctx: CheckContext): Promise<CheckResult[]> {
  const m = PR_RE.exec(url);
  if (!m) return [fail('github', field, `${url} is not a GitHub pull request link`)];
  const [, owner, repo, num] = m;
  if (spec.repo && `${owner}/${repo}`.toLowerCase() !== spec.repo.toLowerCase()) {
    return [fail('github', field, `pull request is on ${owner}/${repo}, not ${spec.repo}`, false)];
  }
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}) };
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  try {
    const res = await get(ctx, `${api}/pulls/${num}`, headers);
    if (res.status === 404) return [fail('github', field, `pull request ${owner}/${repo}#${num} not found`)];
    if (!res.ok) return [warn('github', field, `could not verify ${owner}/${repo}#${num} (GitHub HTTP ${res.status}${res.status === 403 || res.status === 429 ? ', rate limited; set GITHUB_TOKEN' : ''})`)];
    const pr = (await res.json()) as { state?: string; merged?: boolean; merged_at?: string | null; head?: { sha?: string } };
    const merged = pr.merged === true || !!pr.merged_at;
    const out: CheckResult[] = [];
    if (pr.state === 'closed' && !merged) out.push(fail('github', field, `${owner}/${repo}#${num} was closed without merging`));
    else out.push(pass('github', field, `${owner}/${repo}#${num} is ${merged ? 'merged' : 'open'}`));
    if (spec.requireCi && pr.head?.sha) out.push(await ci(field, `${owner}/${repo}#${num}`, `${api}/commits/${pr.head.sha}/check-runs`, headers, ctx));
    return out;
  } catch (err) {
    return [warn('github', field, `could not verify ${owner}/${repo}#${num} (${(err as Error).name === 'TimeoutError' ? 'timed out' : 'network error'})`)];
  }
}

async function ci(field: string, label: string, url: string, headers: Record<string, string>, ctx: CheckContext): Promise<CheckResult> {
  const res = await get(ctx, url, headers);
  if (!res.ok) return warn('ci', field, `could not read CI for ${label} (GitHub HTTP ${res.status})`);
  const runs = ((await res.json()) as { check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs ?? [];
  if (!runs.length) return warn('ci', field, `${label} has no CI runs`);
  const failed = runs.filter((r) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(r.conclusion ?? ''));
  if (failed.length) return fail('ci', field, `CI failing on ${label}: ${failed.map((r) => r.name).join(', ')}`);
  if (runs.some((r) => r.status !== 'completed')) return warn('ci', field, `CI still running on ${label}`);
  return pass('ci', field, `CI passing on ${label} (${runs.length} check${runs.length === 1 ? '' : 's'})`);
}

function wordCount(field: string, text: string, spec: { min?: number; max?: number }): CheckResult {
  const n = words(text);
  if (spec.min !== undefined && n < spec.min) return fail('words', field, `${field} has ${n} words, needs at least ${spec.min}`);
  if (spec.max !== undefined && n > spec.max) return fail('words', field, `${field} has ${n} words, at most ${spec.max} allowed`);
  return pass('words', field, `${field} has ${n} words`);
}

async function runCheck(spec: CheckSpec, field: BriefField, value: FieldValue, ctx: CheckContext): Promise<CheckResult[]> {
  if (field.type === 'url') {
    const url = value.urls[0];
    if (!url) return [];
    if (spec === 'reachable') return [await reachable(field.id, url, ctx)];
    if ('domain' in spec) return [domain(field.id, url, spec.domain)];
    if ('github' in spec) return github(field.id, url, spec.github, ctx);
  }
  if (typeof spec === 'object' && 'words' in spec) return [wordCount(field.id, value.text, spec.words)];
  return [];
}

/** Runs every configured check on one submission's parsed fields. Missing fields are reported by the template layer. */
export async function checkFields(brief: Pick<Brief, 'template'>, fields: Record<string, FieldValue>, ctx: CheckContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const f of brief.template) {
    const v = fields[f.id];
    if (!v) continue;
    for (const spec of f.checks) out.push(...(await runCheck(spec, f, v, ctx)));
  }
  return out;
}

export function deadlineCheck(createdAt: string, deadline: string | null): CheckResult | null {
  if (!deadline || Date.parse(createdAt) <= Date.parse(deadline)) return null;
  return { id: 'deadline', status: 'fail', message: `sent ${createdAt}, after the deadline ${deadline}`, fixable: false };
}

// ---------- duplicates ----------

export interface DuplicateCandidate {
  id: string;
  username: string;
  createdAt: string;
  fields: Record<string, FieldValue>;
}

const normalUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};

function shingles(text: string): Set<string> {
  const w = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}']+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '));
  return out;
}

/** Jaccard similarity of word triples; 1 means the same text. */
export function similarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (A.size < 4 || B.size < 4) return 0; // too short to call a copy
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The earliest submission keeps its place; a later one that reuses its link, or whose text is at or above
 * the threshold, is a duplicate. Returns a failure per duplicate submission id.
 */
export function findDuplicates(subs: DuplicateCandidate[], threshold: number): Map<string, CheckResult> {
  const out = new Map<string, CheckResult>();
  const ordered = [...subs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const textOf = (s: DuplicateCandidate) => Object.values(s.fields).map((f) => f.text).join('\n');
  for (let i = 1; i < ordered.length; i++) {
    const later = ordered[i];
    const laterUrls = new Set(Object.values(later.fields).flatMap((f) => f.urls).map(normalUrl));
    for (const earlier of ordered.slice(0, i)) {
      if (out.has(earlier.id)) continue; // compare against originals only
      const sharedUrl = Object.values(earlier.fields).flatMap((f) => f.urls).map(normalUrl).find((u) => laterUrls.has(u));
      const sim = similarity(textOf(earlier), textOf(later));
      if (sharedUrl || sim >= threshold) {
        out.set(later.id, {
          id: 'duplicate',
          status: 'fail',
          message: sharedUrl ? `uses the same link as @${earlier.username}'s earlier submission` : `${Math.round(sim * 100)}% the same as @${earlier.username}'s earlier submission`,
          fixable: false,
        });
        break;
      }
    }
  }
  return out;
}
