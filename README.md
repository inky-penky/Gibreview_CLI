# gibreview

**Review Gibwork bounty submissions from your terminal or your AI agent.** gibreview checks every submission against the bounty's rules, ranks them into a shortlist with a reason for every verdict, and turns the ranking into decisions: who is paid and how much, who is asked to fix their work, and who is rejected and why. Participants get a free pre-check before they submit.

Built for the Gibwork Developer Hackathon on the official **`@gibwork/sdk`**. A CLI and an MCP server, no web app.

```
brief.yaml ─► gibreview text ─► you create and pay for the bounty on gibwork.com
                                                │
                       participants: gibreview check (free pre-check) ─► submit
                                                │
  gibreview attach ─► collect ─► score (optional AI) ─► rank ─► decide
                                                                  │
                    approve, comment and reject on gibwork.com ◄──┘  (a checklist, then decide --mark-done)
```

## The problem

A popular bounty brings in dozens of submissions, and a standard bounty only takes 50. Some are good, some are spam, some copy an earlier entry, some link to a page that doesn't exist, some arrive after the deadline. The creator reads them all by hand, decides who wins, and writes to the people who nearly made it. Participants find out what was wrong only when they are rejected, after the work is done.

## What gibreview does

**For creators**

1. **Write a brief.** One short YAML file says what to submit, the checks each submission must pass, the judging criteria and how the bounty pays. Presets cover writing (`content`) and code (`dev`) bounties.
2. **Create the bounty on gibwork.com.** `gibreview text` writes the description to paste and tells you what to pick on each tab of "Create Bounty". You pay from your Gibwork account wallet, as usual.
3. **Review.** `attach` connects to the bounty, read-only. `collect` checks every submission: the link opens, it's on an allowed site, the length is right, the pull request is on the right repo, still open or merged, and passing CI. It also finds copies and late work. `rank` puts eligible work first, with a reason for every verdict.
4. **Score (optional).** `score` has Claude rate each eligible submission, and the page it links to, against your criteria, with a note per criterion. The scores are advisory.
5. **Decide.** `decide` turns the ranking into a plan that follows your payout rule. Gibwork pays only from your account wallet, so you carry out the plan on gibwork.com: gibreview gives you a checklist of who to approve and for how much, the comment to post, and the reason to give. `decide --mark-done` records it, so later rounds don't repeat it.

**For participants**

- **Check before you submit.** `gibreview check <taskId> draft.txt` runs the creator's checks on a draft, for free. A submission that only fails a fixable check, like a dead link or failing CI, gets a comment asking for the fix instead of a rejection.

**For AI agents**

- **MCP tools for the whole flow.** An MCP server lets a creator's agent run everything ("review my API-docs bounty and tell me who to pay"), and lets a participant's agent pre-check a draft.

**QA preset**

- **Crowdsourced manual QA.** `gibreview qa` turns a test plan into tester bounties on real phones and browsers, and the results into a release-gate report your CI understands. See [QA preset](#qa-preset-gibreview-qa).

## How it fits with Gibwork

Gibwork creates a Solana wallet for every account, and the website pays only from that wallet. The account wallet can't be exported or linked to another wallet, so nothing outside gibwork.com can pay on a bounty made there. gibreview works with that:

| Bounty created | Paid from | Who pays the winners |
| --- | --- | --- |
| On **gibwork.com** (the usual way) | Your Gibwork account wallet, or a card | **You, on gibwork.com**, following gibreview's checklist |
| From code, with `gibreview publish` | The USDC in the wallet in `SOLANA_PRIVATE_KEY` | gibreview, after you approve the exact total with a confirm code |

Either way, gibreview never holds funds. Gibwork's escrow does.

## Install

Requires **Node.js 22+** (the Gibwork SDK requires it).

```bash
git clone https://github.com/inky-penky/Gibreview_CLI.git gibreview
cd gibreview
npm install          # also builds dist/
npm link             # optional: puts gibreview and gibreview-mcp on your PATH
npm test             # 77 tests, all on the offline simulator
```

Without `npm link`, use `node dist/review/cli.js` in place of `gibreview`.

## Try it in a minute (no wallet needed)

`--mock` swaps Gibwork for a local simulator with the same method shapes. It fills each bounty with realistic submissions: good work, a dead link, a summary too short, a copy, a late entry and spam.

```bash
gibreview publish examples/review/content-brief.yaml --mock --confirm
gibreview collect
gibreview rank
gibreview decide
```

```
  ★ #1  eligible       @ada_writes      2 checks passed
  ★ #2  eligible       @tunde.docs      2 checks passed
     –  needs changes  @kemi_b          https://dev.to/kemi/payments-guide-404 returns 404 (page not found)
     –  needs changes  @shorty          summary has 6 words, needs at least 30
     –  disqualified   @copycat         86% the same as @ada_writes's earlier submission
     –  disqualified   @late_lara       sent …, after the deadline …
     –  invalid        @quickcash99     no SUBMISSION block: the template was not used

  PAY     @ada_writes      25.00 USDC  1st place
  PAY     @tunde.docs      15.00 USDC  2nd place
  CHANGES @kemi_b          Thanks for your submission. It can't be accepted yet: … returns 404 (page not found). Please fix this and reply here when it's done.
  CHANGES @shorty          Thanks for your submission. It can't be accepted yet: summary has 6 words, needs at least 30. …
  REJECT  @copycat         Not accepted: 86% the same as @ada_writes's earlier submission.
  REJECT  @late_lara       Not accepted: sent …, after the deadline ….
  REJECT  @quickcash99     Not accepted: the submission does not use the SUBMISSION block from the bounty description.

  40.00 USDC to 2 winners · 2 fix requests · 3 rejections · 0 held
```

## Review a bounty you create on gibwork.com

**1. Write the brief.**

```bash
gibreview init brief.yaml --preset content     # or --preset dev
```

**2. Get the bounty text.**

```bash
gibreview text brief.yaml
```

```
✓ Wrote the description to brief.description.txt

On gibwork.com, Create Bounty:
  title        Beginner guide to the payments API
  category     Misc
  options      Open to Everyone · due Fri Oct 30 2026
  payment      Custom minimum $10.00 (each approved submission is paid at least this; the tiers are only suggestions)
  description  paste everything in brief.description.txt

Then Continue to Payment:
  bounty amount  $50 unlocks up to 50 submissions, reach ~200 freelancers, daily digest email
  pay with       Wallet: the Solana wallet Gibwork made for your account (deposit USDC to it first if it is short)
                 or Card. Any platform fee is shown before you pay.
  Authorize & Publish moves the money. Everything before it is safe to click through.
```

The description file holds only the bounty text: your description, the judging criteria, the submission template, one rule line per field and the payout. Paste the whole file. The website offers bounty amounts of $50, $100, $200, $380 and $700, so `text` picks your pool's amount, or the next one up, and says how much will be left to refund.

**3. Attach and review.**

```bash
gibreview attach <taskId> --brief brief.yaml   # read-only
gibreview collect                              # run the checks; again later for new submissions
gibreview score                                # optional, needs ANTHROPIC_API_KEY
gibreview rank                                 # shortlist + review-report/review.md and review.json
gibreview show @username                       # one submission with every check result
```

`attach` reads the pool and the minimum per approved submission from Gibwork. It warns if the bounty's text lists no rules or different ones from the brief, and if any payout in the brief is below the bounty's minimum.

**4. Decide, then do it on gibwork.com.**

```bash
gibreview decide
```

```
This bounty was made on gibwork.com, so it belongs to the wallet Gibwork created for the creator's account,
and only that account can pay, reject or refund on it. Do these on gibwork.com, signed in as the creator:

  1. Approve @ada_writes's submission and pay 25.00 USDC (1st place)
  2. Approve @tunde.docs's submission and pay 15.00 USDC (2nd place)
  3. Comment on @kemi_b's submission: "Thanks for your submission. It can't be accepted yet: …"
  …

When they are all done: gibreview decide --mark-done --confirm pay-40.00-USDC-7c1e2a
```

Once a participant fixes their work, `collect --recheck` and `decide` again: a fixed submission takes the next open place. When the bounty is over, refund what is left on gibwork.com.

## The brief

```yaml
name: Beginner guide to the payments API
preset: content            # content | dev | custom
description: |
  Write a beginner-friendly guide to our three payments endpoints…
bounty:
  pool: "50.00"            # the website offers $50, $100, $200, $380 or $700
  minimum: "10.00"         # payment tab: the least any approved submission is paid
  category: Misc           # Social Media | Development | Design | Feedback | Misc
  access: everyone         # everyone | verified | discord | link
  deadlineHours: 72
criteria:                  # judging criteria, shown to participants and used by score
  - { text: Covers all three endpoints with working examples, weight: 40 }
  - { text: Accurate against the API reference, weight: 40 }
  - { text: Clear for someone new to payments, weight: 20 }
payout:
  rule: multiple-winners   # one-winner | multiple-winners | pool
  amounts: ["25.00", "15.00", "10.00"]
review:
  duplicates: 0.85         # this similar to an earlier submission is a copy
  order: first-come        # tie-breaker: first-come or reputation
```

Annotated examples: [`examples/review/content-brief.yaml`](examples/review/content-brief.yaml) and [`examples/review/dev-brief.yaml`](examples/review/dev-brief.yaml).

| Preset | Template fields | Checks |
| --- | --- | --- |
| `content` | `link`, `summary` | the link opens; summary 30 to 250 words |
| `dev` | `pr`, `notes` | a GitHub pull request on the right repo, not closed unmerged, CI passing; notes length |
| `custom` | your own fields | `reachable`, `domain`, `words` and `github` on any field |

**Payouts.** Every brief must state how the bounty pays; nothing is assumed.

| `payout.rule` | `amounts` | Pays |
| --- | --- | --- |
| `one-winner` | one amount | the best eligible submission |
| `multiple-winners` | one amount per place | the top 3, top 10 and so on, by place |
| `pool` | one amount | every eligible submission the same amount, until the pool runs out (or `maxWinners`) |

The brief is rejected, with the reason, if:
- payouts add up to more than the pool
- a payout is below the minimum
- a check is on the wrong kind of field
- a rule's amounts don't fit it

## Checks and verdicts

| Verdict | Meaning | Decision |
| --- | --- | --- |
| `eligible` | every check passed | fills the paid places in rank order; beyond them, held as a runner-up |
| `needs-changes` | only fixable checks failed (a dead link, failing CI, a missing field) | a comment asking for the fix, while a paid place is still open |
| `disqualified` | a copy, late work, the wrong repository | rejected with the reason |
| `invalid` | the SUBMISSION block was not used | rejected with the reason |

- **Copies.** A reused link, or text at or above `review.duplicates` similarity to an earlier submission. Only the earliest copy keeps its place.
- **Fair to participants.** A site that can't be reached or rate-limits a check gives "unverified", never a failure. Set `GITHUB_TOKEN` for higher GitHub rate limits.
- **Ranking order.** AI scores when every eligible submission has a current one; then fewer unverified checks; then the brief's tie-breaker (first-come, or Gibwork reputation).

## AI scoring

`gibreview score` sends each eligible submission, with the text of the pages it links to, to Claude. Claude scores each criterion from 0 to 10, with a note a creator can check. The total out of 100 is weighted as the brief says.

- **Untrusted content is treated as data.** The model is told that submissions and their pages are data to judge, never instructions.
- **Scores track the exact submission.** Each score belongs to one version of a submission. A changed submission must be scored again.
- **No partial ordering.** Scores order the shortlist only when every eligible submission has a current one.

The scores and notes appear in `review.md` and `review.json`. Set `ANTHROPIC_API_KEY`; `GIBREVIEW_AI_MODEL` changes the model (default `claude-sonnet-5-5`).

## For participants: check before you submit

A bounty made with gibreview lists its rules, one line per field, in a fixed wording that people can read and gibreview can parse:

```
pr (required): a link; a GitHub pull request on acme/payments-sdk with passing CI
notes (required): text; 15 to 400 words
```

```bash
gibreview check <taskId> my-submission.txt     # or "-" to read from stdin
```

```
  ✓ github     acme/payments-sdk#45 is open
  ✗ ci         CI failing on acme/payments-sdk#45: test
  ✗ words      notes has 2 words, needs at least 15

✗ Fix these 2 problems before you submit: CI failing on acme/payments-sdk#45: test; notes has 2 words, needs at least 15.
```

- **Exit code.** It exits 0 when the draft is ready.
- **No rules in the bounty.** For a bounty that lists no rules, pass the creator's brief with `--brief`.
- **Copies aren't checked here.** A pre-check can't see other people's submissions, so copies are caught at review time.

## Bounties created from code

`gibreview publish brief.yaml` shows the cost; with `--confirm` it creates and funds the bounty from the wallet in `SOLANA_PRIVATE_KEY`. That wallet owns the bounty, so gibreview can also settle it:

```bash
gibreview decide --apply --confirm <code>      # pays, comments and rejects exactly what the dry run showed
gibreview close --confirm                      # refunds what nobody won
```

- **Confirm code.** The code is a hash of the run, the total and every action with its amount. If anything changed since the dry run, it is refused.
- **Never pays twice.** Each action is saved as it completes, so an interrupted run resumes without paying anyone twice.
- **Stops when unsure.** It stops at an uncertain payment, and stops paying if Gibwork reports that an approval closed the bounty.
- **Close checks first.** `close` refuses while planned winners are unpaid, unless you pass `--force`.

## Commands

| Command | What it does | Moves money |
| --- | --- | --- |
| `gibreview init [file] [--preset content\|dev]` | Writes an example brief | no |
| `gibreview text <brief> [--out file] [--stdout]` | Bounty description and the steps for gibwork.com | no |
| `gibreview attach <taskId> --brief <file> [--stage] [--mock]` | Connects a review run to a bounty | no |
| `gibreview collect [--recheck]` | Fetches submissions and runs the checks | no |
| `gibreview score [--model id]` | Optional AI rubric | no |
| `gibreview rank [--out dir]` | Ranked shortlist, `review.md` and `review.json` | no |
| `gibreview show <id\|@user>` | One submission with every check result | no |
| `gibreview decide` | The plan: pay, ask for a fix, reject, hold | no |
| `gibreview decide --mark-done --confirm <code>` | Records a plan you carried out on gibwork.com | no |
| `gibreview decide --apply --confirm <code>` | Carries out the plan (bounties created from code) | yes |
| `gibreview close [--confirm] [--force]` | Refunds what nobody won (bounties created from code) | with `--confirm` |
| `gibreview publish <brief> [--confirm] [--prod] [--mock]` | Creates and funds a bounty from code | with `--confirm` |
| `gibreview check <taskId> <file> [--brief file]` | Participant pre-check | no |
| `gibreview status` | The review run | no |
| `gibreview qa …` | The QA preset ([below](#qa-preset-gibreview-qa)) | some commands |

Global options are `--dir <path>` (state, default `.gibreview`) and `--run <id>` (an older run). `attach` and `check` use Gibwork production, where gibwork.com bounties live, unless `--stage` is given; `publish` uses stage unless `--prod` is given.

## Environment variables

Copy `.env.example` to `.env.local` (gitignored). Variables already set in your shell win over `.env.local`, which wins over `.env`.

| Variable | Needed | Meaning |
| --- | --- | --- |
| `SOLANA_PRIVATE_KEY` | to talk to Gibwork | The wallet gibreview signs with. It reads bounties, and pays only for bounties it created. Base58 or a JSON byte array, never a recovery phrase. Never commit it or paste it into a chat. |
| `GIBWORK_ENV` | no | Forces `stage` or `production` for every command |
| `GIBREVIEW_MOCK` | no | `1` uses the offline simulator |
| `GITHUB_TOKEN` | no | Higher GitHub rate limits for pull request checks |
| `ANTHROPIC_API_KEY` | for `score` and `qa generate --ai` | Claude API key |
| `GIBREVIEW_DIR` | MCP only | State root, default `./.gibreview` (QA runs in its `qa` folder) |
| `GIBREVIEW_MCP_ALLOW_PRODUCTION` | MCP only | `1` lets agents pay on production; they still need the confirm code |
| `GIBREVIEW_MCP_MAX_BUDGET` | MCP only | Most escrow one QA run may fund through the MCP server |

## MCP server (for AI agents)

```json
{
  "mcpServers": {
    "gibreview": {
      "command": "node",
      "args": ["/absolute/path/to/gibreview/dist/mcp.js"],
      "env": {
        "SOLANA_PRIVATE_KEY": "…",
        "GIBREVIEW_DIR": "/absolute/path/to/your-project/.gibreview"
      }
    }
  }
}
```

| Tools | For |
| --- | --- |
| `review_text`, `review_attach`, `review_collect`, `review_score`, `review_rank`, `review_decide`, `review_close`, `review_status` | creators: the whole review, ending in a website checklist or, for bounties created from code, payment |
| `review_precheck` | participants: read-only pre-check |
| `qa_generate_plan`, `qa_import_csv`, `qa_plan`, `qa_preview_bounty`, `qa_publish`, `qa_status`, `qa_collect`, `qa_triage`, `qa_report` | the QA preset |

### Spend guards

The agent never holds a key, and it can't choose payees or amounts: those come from the brief's payout rule or the test plan.

1. **Confirm codes tied to the exact plan.** Dry runs return the cost and a code such as `pay-40.00-USDC-7c1e2a`. Only that exact code is accepted, and any change to the plan makes a new one. A call without a code returns the cost and tells the agent to get the user's approval.
2. **Website bounties stay with the user.** For a bounty made on gibwork.com, `review_decide` returns the checklist. The agent records it with `markDone` only after the user says it is done.
3. **Production is opted into by the operator.** Paying on production also needs `GIBREVIEW_MCP_ALLOW_PRODUCTION=1` in the server's environment.
4. **Budget cap.** `GIBREVIEW_MCP_MAX_BUDGET` caps what a QA run may fund, counting what it already funded. A value that can't be read blocks spending.
5. **Some steps stay human.** Closing a review while winners are unpaid, and refunding a QA run, are not agent tools.

`node examples/mcp-agent-demo.mjs` shows an agent session end to end on the simulator.

## QA preset (`gibreview qa`)

Crowdsourced manual QA: a test plan becomes paid bounties for testers on real phones and browsers, and their results become a release-gate report.

```
testplan.yaml ─► gibreview qa plan ─► publish ─► Gibwork bounties ─► testers on real devices
                                                                          │
     CI / agent ◄── exit code + junit.xml ◄── report ◄── triage ◄── collect
```

```bash
npm run demo                                   # the whole loop on the simulator
gibreview qa init testplan.yaml
gibreview qa plan testplan.yaml --mock
gibreview qa publish --confirm
gibreview qa collect
gibreview qa triage                            # dry run: who is paid and why
gibreview qa triage --apply
gibreview qa report                            # exits 1: the coupon bug blocks the release
```

**The QA steps**

1. **Plan.** It validates a YAML test plan (cases, steps, expected results, priorities, device classes). It splits the plan into bounties of about 20 minutes each, one per device class and group of cases. See [`examples/checkout-regression.yaml`](examples/checkout-regression.yaml). The budget is `perTester × testersPerBatch × bounties`.
2. **Start from what you have.**
   - `gibreview qa generate <url>` drafts cases from a feature page. It uses a rule-based writer, or Claude with `ANTHROPIC_API_KEY`.
   - `gibreview qa import cases.csv --url <build>` reads Excel, Google Sheets, TestRail, Zephyr, Xray or Qase exports.
   - Drafts are marked `draft: true`, and `plan` refuses them until a person has reviewed them.
3. **Testers submit** a block with their own case ids:

   ```
   QA RESULT
   Device: Tecno Spark 20, Android 13, Chrome 128
   TC-01: PASS
   TC-02: FAIL - Pay button stays disabled after applying SAVE10 - https://drive.google.com/…
   TC-03: BLOCKED - staging returned 502
   END
   ```

   The parser accepts HTML, bullets, any capitalisation and `:`, `=` or `-` separators. It is strict about what decides payment: every case answered, a description and an evidence link for each FAIL, a reason for each BLOCKED, and a device line.
4. **Triage** pays complete, evidenced work first come, first served, up to the tester slots, and rejects the rest with a reason.
5. **Report** builds a case × device matrix. Two testers reproducing a failure gives **FAIL**; testers disagreeing gives **DISPUTED**. It writes `report.md`, `results.csv`, `junit.xml` and `summary.json`.

   The exit code is the release gate:
   - `0`: the release passes
   - `1`: it's blocked
   - `2`: coverage is missing

   [`examples/github-action-release-gate.yml`](examples/github-action-release-gate.yml) runs it in CI, and [`examples/sample-output/`](examples/sample-output/) is a full run.

The QA commands are `init`, `generate`, `import`, `plan`, `publish`, `status`, `collect`, `triage`, `report`, `refund`, `show` and `doctor`. Run `gibreview qa --help` for options. QA runs are stored in `.gibreview/qa`, and reports go to `qa-report/`.

## Safety and reliability

- **Nothing moves money without an explicit flag.** `publish --confirm`, `decide --apply`, `close --confirm`, `qa triage --apply` and `qa refund --confirm`. Dry runs show the exact amounts first.
- **Saved before every payment, never retried blindly.** Each published bounty and each payment is saved with an atomic write as it happens. If the SDK reports an uncertain transaction (`GibworkAmbiguousSubmitError`), the run records it and stops, so nobody is paid twice.
- **One process per run.** Commands that change a run hold a lock on it, so a terminal and an agent can't pay the same run at once. A lock left by a crashed process is cleared.
- **Unknown Gibwork statuses are never guessed.** They are held for a person to check.
- **Participant links are only fetched.** Fetches have timeouts, nothing from them is run, and only the AI scorer reads page text.
- **Keys stay local.** The key goes to the SDK's signer and is never written to state or logs.

## Project layout

```
src/
  review/       gibreview: brief, checks, collect and rank, decide, pre-check, AI scoring, MCP tools, CLI
  template.ts   submission templates: render, tolerant parse, missing fields
  spendguard.ts confirm codes, production opt-in, budget cap
  state.ts      run state, atomic saves, per-run locks
  gibwork.ts    SDK client factory and environment selection
  mock.ts       offline simulator with the SDK's method shapes
  mcp.ts        MCP server
  cli.ts, engine.ts, plan.ts, parser.ts, aggregate.ts, report.ts, content.ts,
  generate/, csvcases.ts, importplan.ts   the QA preset
  test/         unit and end-to-end tests on the simulator
examples/       briefs, a QA plan, demo scripts, CI workflow, sample output
docs/           plan.md (design and open questions), verification.md (checking it on real Gibwork)
```

## Status and limits

- **Built and tested on the simulator.** All 77 tests and both demos run offline. Checking it against real Gibwork needs a small real bounty: follow [docs/verification.md](docs/verification.md). Open questions for Gibwork are in [docs/plan.md](docs/plan.md), section 9.
- **Checklists have no direct links yet.** The website checklist doesn't link to each submission yet, because gibreview doesn't know gibwork.com's submission page address.
- **Fixing a submission depends on Gibwork.** How a participant fixes a submission after a comment (a reply, an edit, or a new submission) is up to Gibwork; gibreview re-checks whatever changed.
- **Evidence is links, not files.** The SDK has no media upload, so evidence is a link.

## License

MIT. `@gibwork/sdk` currently ships as UNLICENSED while Gibwork finalises its license.
