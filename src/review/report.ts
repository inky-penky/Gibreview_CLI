import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash, type RankedEntry, type ReviewState, type ReviewVerdict } from './engine.js';

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const LABEL: Record<ReviewVerdict, string> = { eligible: '✅ eligible', 'needs-changes': '✏️ needs changes', disqualified: '⛔ disqualified', invalid: '🗑️ invalid' };

export function renderShortlist(state: ReviewState, ranked: RankedEntry[]): string {
  const { brief, task } = state;
  const out: string[] = [];
  const count = (v: ReviewVerdict) => ranked.filter((r) => r.submission.verdict === v).length;
  out.push(`# Review · ${brief.name}`, '');
  out.push(`Run \`${state.runId}\` · environment **${state.environment}** · task ${task.id ?? 'not published'} · pool ${task.pool} ${task.symbol}${task.deadline ? ` · deadline ${task.deadline}` : ''}`);
  out.push(`Generated ${new Date().toISOString()}${state.collectedAt ? `, submissions collected ${state.collectedAt}` : ''}`, '');
  out.push(`**${ranked.length}** submissions: ${count('eligible')} eligible, ${count('needs-changes')} need changes, ${count('disqualified')} disqualified, ${count('invalid')} invalid.`, '');

  const shortlist = ranked.filter((r) => r.shortlisted);
  out.push('## Shortlist', '');
  if (!shortlist.length) out.push('No submission passed every check yet.', '');
  for (const r of shortlist) {
    const s = r.submission;
    out.push(`### ${r.place}. @${s.username}`, '');
    for (const [k, v] of Object.entries(s.fields)) out.push(`- **${k}:** ${v.urls[0] ?? md(v.text.slice(0, 300))}`);
    out.push(`- Checks: ${r.reason}`);
    const ai = s.aiScore && s.aiScore.contentHash === contentHash(s.content) ? s.aiScore : null;
    if (ai) {
      out.push(`- AI score ${ai.score}/100 (advisory, ${ai.model}): ${md(ai.summary)}`);
      for (const c of ai.byCriterion) out.push(`  - ${md(c.criterion)}: ${c.score}/10. ${md(c.note)}`);
    }
    if (r.warnings.length) out.push(`- Unverified: ${r.warnings.map(md).join('; ')}`);
    if (s.reputation) out.push(`- Gibwork record: ${s.reputation.approved} approved, ${s.reputation.rejected} rejected, rating ${s.reputation.rating}`);
    out.push('');
  }

  out.push('## All submissions', '');
  out.push('| Place | Participant | Verdict | Sent | Why |', '| --- | --- | --- | --- | --- |');
  for (const r of ranked) {
    const s = r.submission;
    out.push(`| ${r.place ?? '–'} | @${md(s.username)} | ${LABEL[s.verdict]} | ${s.createdAt.slice(0, 16).replace('T', ' ')} | ${md(r.reason)} |`);
  }
  out.push('');
  if (brief.criteria.length) {
    out.push('## Judging criteria (for the creator)', '');
    for (const c of brief.criteria) out.push(`- ${c.text}${brief.criteria.length > 1 ? ` (${c.weight})` : ''}`);
    out.push('');
  }
  out.push('Automated checks rank submissions; they do not pay anyone. Read the shortlisted work before deciding.');
  return out.join('\n') + '\n';
}

export async function writeShortlist(state: ReviewState, ranked: RankedEntry[], outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const mdPath = join(outDir, 'review.md');
  const jsonPath = join(outDir, 'review.json');
  await writeFile(mdPath, renderShortlist(state, ranked));
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        runId: state.runId,
        taskId: state.task.id ?? null,
        ranked: ranked.map((r) => ({
          place: r.place,
          shortlisted: r.shortlisted,
          submissionId: r.submission.id,
          username: r.submission.username,
          verdict: r.submission.verdict,
          reason: r.reason,
          checks: r.submission.checks,
          fields: r.submission.fields,
          aiScore: r.submission.aiScore && r.submission.aiScore.contentHash === contentHash(r.submission.content) ? r.submission.aiScore : null,
        })),
      },
      null,
      2,
    ) + '\n',
  );
  return [mdPath, jsonPath];
}
