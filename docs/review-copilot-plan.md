# Gibwork Review Copilot: implementation plan

Status: proposal · Branch: `release-hardening` · Supersedes the QA-only scope of BugBash, which becomes the `qa` preset.

## 1. Goal

Give Gibwork bounty creators a CLI and MCP server that turns a pile of submissions into a ranked shortlist with a reason for every decision, then settles the bounty through Gibwork's escrow. Give participants a free pre-check before they submit, and a chance to fix work instead of an instant rejection.

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

**How payouts work (confirmed by the project owner, 2026-10-27):**

- The creator must state how the bounty pays; the copilot never assumes a rule or a number of winners:
  - `one-winner`: one submission is paid
  - `multiple-winners`: a set amount per place for the top 3, top 10 and so on
  - `pool`: every accepted submission earns the same amount until the pool runs out (or `maxWinners`)
- Approving one winner does not close the bounty. Every winner is paid by its own `approve` call.
- Each winner gets the amount for their place, but never less than the bounty's **minimum per approved submission** (`minSubmissionAmount`). On the website this is the payment tab: a tier or a custom minimum; the preview shows "Minimum $25 per approved submission". The tiers ($10+ or $25+ "Anyone" depending on category) are only suggestions: on 2026-10-27 a custom minimum of $2 on a Development bounty was accepted through to the payment page. The brief's `bounty.minimum` sets it (default: the smallest payout), validation rejects any payout below it, and `decide` holds a place that would pay less than an attached bounty's minimum.
- The whole pool goes to winners. Any Gibwork fee is paid by the creator, not taken from winners.
- Money nobody wins is refunded to the creator through `close`.

**Participation.**
- The SDK documents a submission fee ("currently 0.15 USDC") for submissions made through the API. Gibwork's site does not show a fee for joining bounties, so the copilot never assumes one. It reads the `fee` quote when it matters.
- Some bounties have eligibility rules: `requiresPremium` (subscribers only), verified accounts, Twitter follower or engagement minimums, or Discord server and role membership. Gibwork enforces these before anyone can submit, so review does not check them.
- The website's options tab sets who can participate: Open to Everyone, Only Verified Accounts, Only to those with a Link, Only Discord Members. The brief's `bounty.access` mirrors it. The SDK can set verified and Discord; "link" exists only on the website, so `publish` refuses it and points to `text` plus `attach`.
- Categories on the website: Social Media, Development, Design, Feedback, Misc (`bounty.category`, sent as the first tag).

**The website's payment page** (seen 2026-10-27, after "Continue to Payment"):
- The **bounty amount** (the pool) can only be one of five amounts; there is no custom amount. Each unlocks more reach:

  | Pool | Unlocks |
  | --- | --- |
  | $50 | up to 50 submissions, reach ~200, daily digest email |
  | $100 | up to 50 submissions, reach ~800, pushed to verified contributors |
  | $200 | up to 50 submissions, reach ~13,500, pushed to verified contributors |
  | $380 | the same as $200 as listed (reported to Gibwork as a likely bug) |
  | $700 | up to 50 submissions, reach ~32,000, expert contributors, success manager, cross-posted to Gibwork X and Discord |

  The SDK accepts other pools, so only website bounties are limited to these. `gibreview text` picks the matching amount, or the next one up and says how much `close` will refund.
- Pay with Wallet (deposit USDC to it first when the balance is short) or Card. The **platform fee was $0.00** at every amount; "Total to pay" equals the pool.
- Every tier caps a bounty at **50 submissions**; Gibwork Plus makes it unlimited (the SDK's `maxSubmissions`, `standardSubmissionSlotsRemaining`). Spam and copies use up slots good work could have taken.
- Typo on the page: "Expert contributors Guranteed".
- **Authorize & Publish** is the step that moves money.
- **Gibwork creates a Solana wallet for every account, and the app pays only from that wallet** (confirmed by the project owner, 2026-10-27). "Pay with Wallet" spends its balance, so the creator needs a Gibwork account and must deposit USDC to it first; "Pay with Card" is the alternative.

**Who can pay on a bounty.** The SDK signs with `SOLANA_PRIVATE_KEY` and spends that wallet's own USDC; only the wallet that created a bounty can approve, reject or refund on it (`tasks.list` reports `canApprove`, `canReject`, `canRefund`). A bounty made on gibwork.com belongs to the account's Gibwork-created wallet, not to an external wallet such as Phantom, so `attach` sets `walletCanPay: false` and `decide` prints a website checklist instead of paying; `decide --mark-done` records it. Bounties made with `gibreview publish` belong to the `SOLANA_PRIVATE_KEY` wallet, and gibreview pays on them itself.

The account wallet **cannot be exported**; the app only offers deposit and withdraw (confirmed by the project owner, 2026-10-27). So for bounties made on gibwork.com the website checklist is the permanent flow: gibreview reviews, ranks and plans, and the creator approves, comments, rejects and refunds on the site. Automatic payment is only for bounties made with `gibreview publish`.

Open questions for Gibwork:
- Can an account delegate approvals to another wallet, or link an external wallet? That would let gibreview pay on website bounties without exporting anything.
- Does a bounty made through the SDK with an external wallet show up under a Gibwork account, and which one?

**Still unverified, must be checked on stage (section 9):** the pool amount format, whether a participant can answer a comment without submitting again, and the submission statuses after approval.

## 3. How a creator uses it

```bash
gibreview brief init api-docs.yaml --preset content     # or: gibreview attach <taskId>
gibreview publish --confirm                             # skip when attaching to an existing bounty
gibreview collect                                       # fetch and check every submission
gibreview rank                                          # shortlist with scores and reasons
gibreview decide                                        # dry run: PAY / CHANGES / REJECT / HOLD
gibreview decide --apply --confirm <code>               # pays through escrow, comments, rejects
gibreview close --confirm                               # refund what is left, write the report
```

Agent version, over MCP: "Review the submissions on my API-docs bounty, shortlist the top 3 and tell me who to pay." The agent calls `review_collect`, `review_rank`, shows the shortlist and cost, then `review_decide` with the confirm code once the user agrees.

## 4. How a participant uses it

1. The bounty text contains a **submission template** and the acceptance criteria.
2. Before submitting, they run the free pre-check:
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
  rule: multiple-winners        # required: one-winner | multiple-winners | pool
  amounts: ["15.00", "10.00", "5.00"]
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
| M2 ✅ | Brief format, `attach`, `collect`, checks for `dev` and `content`, `rank`, shortlist report | no (except `publish --confirm`) |
| M3 ✅ | `decide` with payout rules, request-changes comments, confirm code on approvals, `close` (CLI; the `review_*` MCP tools are not built yet) | yes |
| M4 ✅ | Participant pre-check (`check` command and `review_precheck` tool); bounties publish their rules in a fixed wording the pre-check reads back | no |
| M5 | Stage verification pass (section 9), mock updated to match | yes, small |
| M6 (stretch) | AI rubric scorer | no |

M1, M2 and M4 can be built and demoed fully on the mock, without funds.

## 9. Questions for Gibwork and the stage pass

1. **Minimum pool.** `prepareCreate` rejected `"1.00"` and `"1.01"` with "must be between 1.00 and 100000.00 inclusive". What format and minimum does `payment.amount` expect?
2. ~~**Multiple winners.**~~ Answered: several approvals with different amounts, no minimum per approval, and leftovers are refunded (section 2). Still worth confirming on stage that a second `approve` succeeds after the first.
3. **Changes without resubmitting.** Can a participant reply to a creator comment, or edit their submission, without submitting again (and paying the SDK submission fee when it applies)?
4. **Statuses.** Which statuses does a submission pass through after `approve`?
5. **Visibility.** Can participants see each other's submissions? This changes how much duplicate detection matters.
6. **Network.** Stage bounties use the mainnet USDC mint. Does stage move real USDC?
7. **Amount units in task details.** Discovery reports `asset.amount` as a base-unit string; `tasks.get` types it as a number. `attach` assumes base units for the pool it displays.
8. ~~**The website's "payment" tab.**~~ Answered from the website: it is the minimum per approved submission (section 2). The website accepts a custom minimum below the lowest tier ($2 on Development reached the payment page), so the tiers are suggestions; reported to Gibwork as confusing, since "$25+" reads as a floor. Still open: does "Authorize & Publish" (or the API) enforce any floor on the minimum or the pool? That is what question 1 needs.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| AI scores feel unfair | Advisory only, explanation per score, creator confirms every payout |
| Checks fetch participant links | Fetch with timeouts and size limits, never execute content |
| GitHub API rate limits for `github-pr` | Optional `GITHUB_TOKEN`; degrade to "unverified" instead of failing |
| Rejected participants lose their effort (and the fee, when one applies) | Pre-check first, request-changes before reject |
| Gibwork API differs from assumptions | M5 before any production use; mock mirrors what stage shows |
