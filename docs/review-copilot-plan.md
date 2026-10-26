# Gibwork Review Copilot: implementation plan

Status: proposal · Branch: `release-hardening` · Supersedes the QA-only scope of BugBash, which becomes the `qa` preset.

## 1. Goal

Give Gibwork bounty creators a CLI and MCP server that turns a pile of submissions into a ranked shortlist with a reason for every decision, then settles the bounty through Gibwork's escrow. Give participants a free pre-check before they pay the submission fee, and a chance to fix work instead of an instant rejection.

**Non-goals.** No web dashboard. No custody: Gibwork escrow holds and pays all funds. Nothing is approved without the creator's confirmation; AI scores are advice, never a decision.

## 2. What the SDK gives us (verified against `@gibwork/sdk` 0.2.0 types)

| Need | SDK call | Notes |
| --- | --- | --- |
| Review bounties made on the Gibwork site | `tasks.list`, `tasks.get` | Attach by task id; no need to publish through the copilot |
| Publish with escrow | `tasks.create`, `tasks.prepareCreate` | `prepareCreate` returns the fee quote unsigned |
| Read submissions | `submissions.list`, `submissions.get` | Each has `user.approvedTaskSubmissions`, `rejectedTaskSubmissions`, `rating` |
| Request changes | `submissions.comments.create` | Comment on the submission instead of rejecting |
| Pay winners | `submissions.approve(taskId, id, { amount, rating })` | Amount per submission enables top-N splits |
| Reject | `submissions.reject(taskId, id, reason)` | |
| Clarify the bounty | `tasks.update` | Content and deadline only |
| Close | `tasks.refund`, `tasks.prepareRefund` | Refunds carry their own platform fee (quote available) |

**Unverified, must be checked on stage (section 9):** the minimum pool rule, approving several submissions with different amounts, whether a participant can answer a comment without paying a new fee, and the submission statuses after approval.

## 3. How a creator uses it

```bash
gibreview brief init api-docs.yaml --preset content     # or: gibreview attach <taskId>
gibreview publish --confirm                             # skip when attaching to an existing bounty
gibreview collect                                       # fetch and check every submission
gibreview rank                                          # shortlist with scores and reasons
gibreview decide                                        # dry run: PAY / CHANGES / REJECT / HOLD
gibreview decide --apply                                # pays through escrow, comments, rejects
gibreview close --confirm                               # refund what is left, write the report
```

Agent version, over MCP: "Review the submissions on my API-docs bounty, shortlist the top 3 and tell me who to pay." The agent calls `review_collect`, `review_rank`, shows the shortlist and cost, then `review_decide` with the confirm code once the user agrees.

## 4. How a participant uses it

1. The bounty text contains a **submission template** and the acceptance criteria.
2. Before paying the 0.15 USDC submission fee, they run the free pre-check:
   `npx gibreview check <taskId> my-submission.txt` (or ask their own agent, through the MCP tool `review_precheck`).
   It reads the template from the bounty and reports every problem a creator-side check would find.
3. If a fixable check fails after submitting (a dead link, a missing field), they get a comment asking for the fix instead of a rejection.

## 5. The brief (creator input)

```yaml
name: Guide to the payments API
preset: content                 # dev | content | qa | custom
bounty:                         # omit when attaching to an existing task
  pool: "30.00"
  deadlineHours: 72
  tags: [Docs]
description: |
  Write a beginner guide to the three payments endpoints, with request and response examples.
template:                       # what every submission must contain
  - id: link
    label: Link to your guide
    type: url
    checks: [reachable, { domain: [dev.to, medium.com, hashnode.dev, github.com] }]
  - id: summary
    label: One-paragraph summary
    type: text
    checks: [{ words: { min: 40, max: 200 } }]
criteria:                       # shown to participants; used by the optional AI rubric
  - { text: Covers all three endpoints with examples, weight: 40 }
  - { text: Accurate against the API reference, weight: 40 }
  - { text: Clear for a beginner, weight: 20 }
payout:
  rule: top-n                   # winner | top-n | threshold
  amounts: ["15.00", "10.00", "5.00"]
  minScore: 60
review:
  ai: false                     # true turns on the rubric scorer (needs ANTHROPIC_API_KEY)
  duplicates: 0.85              # similarity at or above this is a duplicate
```

A submission fills the template as a block, the same idea as today's `BUGBASH RESULT`:

```
SUBMISSION
link: https://dev.to/ada/payments-api-guide
summary: A step-by-step guide that …
END
```

The `qa` preset generates one template field per test case (`TC-01: PASS | FAIL | BLOCKED - note - evidence`), so the current BugBash flow is a preset, not a separate product.

## 6. Review pipeline

```
submission → parse template → hard checks → duplicate / spam → (AI rubric) → verdict → rank → decision
```

Each check returns `{ id, status: pass | warn | fail, message, fixable }`.

| Verdict | Meaning | Default decision |
| --- | --- | --- |
| `invalid` | No template block, or spam | reject with reason |
| `needs-changes` | Only fixable checks failed | comment asking for the fix |
| `disqualified` | Duplicate, ineligible, or after the deadline | reject with reason |
| `eligible` | Every hard check passed | ranked, paid by the payout rule |

**Ranking.** Eligible submissions are ordered by AI rubric score when enabled, otherwise by the order the creator chooses (first come, or manual). Submitter reputation (approved/rejected counts, rating) is shown and used only to break ties, so newcomers are not shut out.

**Decisions.** The payout rule turns the ranking into actions: `approve(amount)`, `request-changes(comment)`, `reject(reason)` or `hold`. The existing spend guard covers every approval: amount-bound confirm code, budget cap, production opt-in.

## 7. Code: what moves where

| Today (BugBash) | Becomes | Change |
| --- | --- | --- |
| `plan.ts` (test plan schema) | `brief.ts` | New schema above; `qa` preset keeps the old fields |
| `content.ts` + `parser.ts` | `template.ts` | Generic template render and parse; QA parsing becomes a template |
| `engine.ts` publish/collect/refund | `engine.ts` | Add `attach`, `comment`; collect stores reputation |
| `engine.ts` `planTriage` | `decide.ts` | Payout rules instead of first-come slots |
| `aggregate.ts` | `presets/qa/aggregate.ts` | Only the QA preset needs tester consensus |
| `report.ts` | `report.ts` | Shortlist report for all presets; matrix/JUnit stay for `qa` |
| `generate/` | `presets/qa/generate/` | Unchanged, QA only |
| `spendguard.ts`, `state.ts`, `mock.ts` | same | Mock gains comments, attach, variable approve amounts |
| `mcp.ts` | `mcp.ts` | Tools renamed `review_*`, plus `review_precheck` |
| (new) | `checks/` | `required`, `url`, `domain`, `words`, `github-pr`, `duplicate`, `deadline`, `qa-cases` |
| (new) | `score/ai.ts` | Rubric scorer, reusing the fetch-and-validate pattern of `generate/ai.ts` |
| (new) | `presets/{dev,content,custom}.ts` | Default templates and checks per bounty type |

CLI name: `gibreview`, with `bugbash` kept as an alias that runs the `qa` preset, so existing docs and the CI example keep working.

## 8. Milestones

Each milestone keeps every existing test green.

| # | Deliverable | Moves money |
| --- | --- | --- |
| M1 ✅ | Generic `template.ts`; QA parser rebuilt on it with identical results | no |
| M2 | Brief format, `attach`, `collect`, checks for `dev` and `content`, `rank`, shortlist report | no |
| M3 | `decide` with payout rules, request-changes comments, spend guard on approvals, `close` | yes |
| M4 | Participant pre-check (`check` command and `review_precheck` tool) | no |
| M5 | Stage verification pass (section 9), mock updated to match | yes, small |
| M6 (stretch) | AI rubric scorer | no |

M1, M2 and M4 can be built and demoed fully on the mock, without funds.

## 9. Questions for Gibwork and the stage pass

1. **Minimum pool.** `prepareCreate` rejected `"1.00"` and `"1.01"` with "must be between 1.00 and 100000.00 inclusive". What format and minimum does `payment.amount` expect?
2. **Multiple winners.** Can one bounty approve several submissions with different amounts? What does `minSubmissionAmount` limit?
3. **Changes without a new fee.** Can a participant reply to a creator comment, or edit their submission, without paying the fee again?
4. **Statuses.** Which statuses does a submission pass through after `approve`?
5. **Visibility.** Can participants see each other's submissions? This changes how much duplicate detection matters.
6. **Network.** Stage bounties use the mainnet USDC mint. Does stage move real USDC?

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| AI scores feel unfair | Advisory only, explanation per score, creator confirms every payout |
| Checks fetch participant links | Fetch with timeouts and size limits, never execute content |
| GitHub API rate limits for `github-pr` | Optional `GITHUB_TOKEN`; degrade to "unverified" instead of failing |
| Rejected participants lose their fee | Pre-check first, request-changes before reject |
| Gibwork API differs from assumptions | M5 before any production use; mock mirrors what stage shows |
