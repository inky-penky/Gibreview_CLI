# Gibwork BugBash

**Crowdsourced manual QA from your terminal.** Turn a test plan into paid Gibwork bounties, let real people run your test cases on real phones and browsers, then collect, verify and pay their results and get a release-gate report your CI understands.

Built for the Gibwork Developer Hackathon. No web app, no dashboard. A CLI and an MCP server built on the official **`@gibwork/sdk`**.

```
testplan.yaml ──► bugbash plan ──► bugbash publish ──► Gibwork bounties ──► testers on real devices
                                                                                     │
  CI / agent ◄── exit code + junit.xml ◄── bugbash report ◄── bugbash triage ◄── bugbash collect
                                                         (pays complete work, rejects the rest)
```

## The problem

Automated tests don't catch everything. The bugs that hurt users most often appear only on a budget Android phone, an older iPhone, a slow network, or a real person's inbox. Large companies pay for device labs and in-house manual testers. Small teams and solo founders usually skip manual regression, ship, and wait for users to report problems.

The coordination is the hard part, not the testing itself. Someone has to find testers, explain the cases, chase results, sort real reports from low-effort ones, pay people, and turn a pile of messages into a release decision.

## What BugBash does

1. **Plan.** Validates a YAML test plan (cases, steps, expected results, priorities, device classes) and splits it into focused bounties, one per device class and chunk of cases, so each job takes about 20 minutes.
2. **Publish.** Creates and funds each bounty through `gibwork.tasks.create`. Every bounty includes the build link, the cases and a strict `BUGBASH RESULT` template for testers to paste back.
3. **Collect.** Pulls submissions with `gibwork.submissions.list` and parses each one against the exact case ids that bounty asked for. Each submission is classified as *valid*, *incomplete* (missing cases, a FAIL without evidence, no device) or *invalid* (no result block).
4. **Triage.** Pays complete, evidenced work first come, first served, up to the number of tester slots, using `gibwork.submissions.approve`. Rejects the rest with `gibwork.submissions.reject` and a reason the tester can act on. This is a dry run by default.
5. **Report.** Builds a case × device matrix. Two testers reproducing a failure gives **FAIL**. Testers disagreeing gives **DISPUTED** (likely flaky). The tool then applies your gate rules and writes `report.md`, `results.csv`, `junit.xml` and `summary.json`. The exit code is the verdict, so a pipeline can block a release on it.
6. **Refund.** Returns unspent escrow with `gibwork.tasks.refund` when the run is over.

All of this is also available to AI agents through an **MCP server**. You can tell your coding agent "run the checkout regression on real phones and tell me if v2.3.0 is safe to ship", and it plans, asks you to approve the budget, publishes, collects, pays and reports.

## Why it's a new Gibwork use case

Most Gibwork tooling helps people find bounties or write them one at a time. BugBash treats Gibwork as a **programmable human test runner**. A structured test plan goes in, many small paid jobs are fanned out, and machine-readable results come back. Those results plug into the same places automated test results already go, such as JUnit reports, CI checks and agent workflows. It also shows why on-chain payouts matter here. Testers anywhere, including the many skilled testers in Nigeria and across Africa who are hard to pay through traditional platforms, get paid in USDC within minutes of a verified result.

## Gibwork toolset used

| Toolset | How BugBash uses it |
| --- | --- |
| **SDK** `@gibwork/sdk` 0.2.x (core) | `tasks.create`, `tasks.list`, `tasks.listAvailable`, `tasks.refund`, `submissions.list`, `submissions.approve`, `submissions.reject`, plus the Node keypair signer. Typed error handling for `GibworkApiError`, `GibworkAmbiguousSubmitError` and rate limits. |
| **MCP** | BugBash ships its own MCP server (`bugbash-mcp`) with 7 tools that wrap the SDK workflow for agents, with spend guards. |
| **CLI** | `bugbash` is a terminal-first CLI on top of the SDK. |

## Install

Requires **Node.js 22+** (the Gibwork SDK requires it).

```bash
git clone https://github.com/YOUR_GITHUB_USER/gibwork-bugbash.git
cd gibwork-bugbash
npm install          # also builds dist/ via the prepare script
npm link             # optional, puts `bugbash` and `bugbash-mcp` on your PATH
npm test             # 9 tests, including a full end-to-end run on the simulator
```

Without `npm link`, replace `bugbash` with `node dist/cli.js` in the commands below.

## Environment variables

Copy `.env.example` to `.env`. It is loaded automatically from the current directory.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SOLANA_PRIVATE_KEY` | for stage/production | Wallet that funds bounties and pays testers. Base58 secret key or a JSON byte array. Never commit it. |
| `GIBWORK_ENV` | no | `stage` (default) or `production`. `--prod` on `plan` does the same. |
| `BUGBASH_MOCK` | no | `1` runs against the offline simulator. Same as `--mock` on `plan`. |
| `BUGBASH_DIR` | MCP only | Where run state lives. The default is `./.bugbash`. |
| `BUGBASH_MCP_ALLOW_PRODUCTION` | MCP only | `1` lets agents spend on production. Agents still need `confirm=true`. |

## Try it in 60 seconds (no wallet needed)

The `--mock` flag swaps the SDK for a local simulator with the same method shapes. It invents a small crowd of testers for every bounty. Some do good work, one reproduces a real bug, one disagrees on a flaky case, one skips a case and one sends spam. You can review the whole loop without funds.

```bash
npm run demo
```

Or step by step:

```bash
mkdir /tmp/qa && cd /tmp/qa
bugbash init testplan.yaml
bugbash plan testplan.yaml --mock
bugbash publish --confirm
bugbash collect
bugbash triage            # dry run, shows who gets paid and why
bugbash triage --apply
bugbash report            # exits 1, the coupon bug blocks the release
```

## Real run on Gibwork stage

```bash
cp .env.example .env      # put a stage wallet key in SOLANA_PRIVATE_KEY
bugbash doctor            # free read-only checks for key, API reachability and wallet auth
bugbash plan testplan.yaml
bugbash publish           # shows the cost, moves nothing
bugbash publish --confirm # funds and publishes the bounties
# … testers submit …
bugbash collect && bugbash triage && bugbash triage --apply
bugbash report
bugbash refund --confirm  # return unspent escrow
```

Use `--prod` on `plan` (or `GIBWORK_ENV=production`) to target production. The environment is fixed per run, so a run's task ids never get mixed across environments.

## Commands

| Command | What it does | Moves money |
| --- | --- | --- |
| `bugbash init [file]` | Writes the sample plan | no |
| `bugbash plan <file> [--mock] [--prod] [--show <batch>]` | Validates, batches, prices and prints a bounty preview | no |
| `bugbash publish [--confirm] [--batch <id>]` | Creates and funds bounties. Skips batches that are already published. | with `--confirm` |
| `bugbash status` | Per-bounty state, submissions and paid slots | no |
| `bugbash collect` | Fetches and parses submissions (all pages) | no |
| `bugbash triage [--apply]` | Plans or executes payouts and rejections | with `--apply` |
| `bugbash report [--out dir] [--format md,csv,junit,json] [--no-gate]` | Writes reports and sets the exit code | no |
| `bugbash refund [--confirm]` | Refunds unspent escrow on every bounty | with `--confirm` |
| `bugbash show <submissionId>` | Shows the raw submission and how it was parsed | no |
| `bugbash doctor [--prod]` | Checks Node version, wallet and Gibwork connectivity | no |

Global options are `--dir <path>` for the state directory and `--run <id>` to work on an older run.

**Report exit codes** are `0` when the release passes, `1` when it is blocked by a failing or disputed case on a `failOn` priority, and `2` when a `requireCoverageOn` case has no usable result on some device.

## Test plan format

See [`examples/checkout-regression.yaml`](examples/checkout-regression.yaml) for a full example. The essentials are below.

```yaml
name: Acme Shop checkout regression
release: v2.3.0
build:
  url: https://staging.acme-shop.example
  notes: Test login and test card details for testers
reward:
  perTester: "2.00"        # USDC per accepted tester
  testersPerBatch: 2       # independent testers per bounty
  # mintAddress: ...       # defaults to USDC
batchSize: 5               # cases per bounty
deadlineHours: 48
gate:
  failOn: [high]
  requireCoverageOn: [high]
devices:
  - id: android-chrome
    label: Android phone (Chrome)
cases:
  - id: TC-02
    title: Apply a coupon at checkout
    priority: high
    steps: [Go to checkout, Enter coupon SAVE10 and tap Apply, Pay with the test card]
    expected: Total drops by 10 percent and the order is placed
    devices: [android-chrome]   # optional, defaults to every device
```

The budget is `perTester × testersPerBatch × number of bounties`, plus Gibwork platform fees. `plan` prints it before anything is published.

## What testers submit

Each bounty ends with a template that has its own case ids already filled in.

```
BUGBASH RESULT
Device: Tecno Spark 20, Android 13, Chrome 128
TC-01: PASS
TC-02: FAIL - Pay button stays disabled after applying SAVE10 - https://drive.google.com/…
TC-03: BLOCKED - staging returned 502
END
```

The parser accepts HTML, bullets, lowercase text, "passed" or "failed", and `:`, `=` or `-` separators, because people paste from many apps. It is strict about what decides payout. Every case must be answered, every FAIL needs a description and an evidence link, every BLOCKED needs a reason, and the device line is required.

## MCP server (for AI agents)

```json
{
  "mcpServers": {
    "gibwork-bugbash": {
      "command": "node",
      "args": ["/absolute/path/to/gibwork-bugbash/dist/mcp.js"],
      "env": {
        "SOLANA_PRIVATE_KEY": "…",
        "BUGBASH_DIR": "/absolute/path/to/your-project/.bugbash"
      }
    }
  }
}
```

The tools are `bugbash_plan`, `bugbash_preview_bounty`, `bugbash_publish`, `bugbash_status`, `bugbash_collect`, `bugbash_triage` and `bugbash_report`.

Spend guards work like this. `bugbash_publish`, and `bugbash_triage` with `apply=true`, refuse unless the agent passes `confirm=true`. The refusal message tells the agent to show the user the cost first. On production they also need `BUGBASH_MCP_ALLOW_PRODUCTION=1`, which only the person running the server can set.

To watch an agent session end to end on the simulator, run this.

```bash
node examples/mcp-agent-demo.mjs
```

## CI release gate

[`examples/github-action-release-gate.yml`](examples/github-action-release-gate.yml) collects results, optionally pays testers, uploads the reports and publishes `junit.xml` as a check. Human test results show up next to your unit tests, and a blocked release fails the job.

## Sample output

The files in [`examples/sample-output/`](examples/sample-output/) come from `npm run demo`.

- [`report.md`](examples/sample-output/report.md) contains the release gate, matrix, failure evidence and tester ledger
- [`junit.xml`](examples/sample-output/junit.xml) has one suite per device and one test case per case
- [`results.csv`](examples/sample-output/results.csv) has one row per tester per case, ready for a spreadsheet
- [`summary.json`](examples/sample-output/summary.json) is the machine-readable gate and matrix
- [`terminal-transcript.txt`](examples/sample-output/terminal-transcript.txt) is the full CLI session

An excerpt from the report:

```
Release gate FAIL
  • TC-02 [high] fails on Android phone (Chrome) (2 fail / 0 pass)

  PASS      TC-01    Guest checkout with card                 android-chrome:PASS  ios-safari:PASS  desktop:PASS
  FAIL      TC-02    Apply a coupon at checkout               android-chrome:FAIL  ios-safari:PASS  desktop:PASS
  DISPUTED  TC-03    Order confirmation email                 android-chrome:PASS  ios-safari:DISPUTED  desktop:PASS
  …
Paid 24.00 USDC to 12 testers
```

## Safety and reliability decisions

- **Nothing moves money without an explicit flag.** `publish`, `triage --apply` and `refund` each need confirmation. Dry runs show the exact amounts first.
- **Idempotent publishing.** Each published task id is saved immediately with an atomic write, so a rerun after a crash or rate limit skips what already went out.
- **Ambiguous transactions are never retried.** If the SDK raises `GibworkAmbiguousSubmitError`, the intent id is recorded, the batch is marked *unresolved* and the run stops. This prevents paying twice.
- **Rate limits.** A `429` stops publishing cleanly and reports the `retryAfter` value.
- **Payout cap.** Triage never approves more testers than a bounty's pool covers. Extra valid work is held, not paid.
- **Spam and rejected work never change the results matrix.**
- **Keys stay local.** The key is passed to the SDK's Node signer and never written to state or logs.

## Project layout

```
src/
  cli.ts        bugbash CLI (commander)
  mcp.ts        MCP server (stdio)
  engine.ts     plan / publish / collect / triage / report / refund, shared by CLI and MCP
  gibwork.ts    SDK client factory and the slice of the SDK BugBash depends on
  mock.ts       offline simulator with the same method shapes as the SDK
  plan.ts       test plan schema (zod), batching, decimal-safe money
  content.ts    bounty HTML and the tester result template
  parser.ts     tolerant result parser and payout validation
  aggregate.ts  case × device consensus and release gate
  report.ts     Markdown, CSV, JUnit XML and JSON writers
  test/         node:test unit and end-to-end tests
examples/       sample plan, demo scripts, CI workflow, sample output
```

## Limitations and next steps

- The Gibwork SDK has no media upload yet, so testers attach evidence as links (Drive, Loom, Imgur), not files.
- Testers are matched by device *class* on trust. A useful next step is asking for a screenshot of the device's About page and checking it.
- Retesting a fixed bug currently means creating a new plan with just that case. A `bugbash retest TC-02` command would make that one step.

## License

MIT. Note that `@gibwork/sdk` currently ships as UNLICENSED while Gibwork finalises its license.
