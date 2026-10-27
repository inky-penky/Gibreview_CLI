# Verifying gibreview on real Gibwork (M5)

Everything in gibreview is tested on the offline simulator. This runbook checks the parts the simulator can only assume, in order of cost: free first, then a small real bounty. Each step names the open question from [plan.md](plan.md) section 9 that it answers. Write down what you see; anything that differs from the "expect" line is a finding to fix in gibreview, or to ask Gibwork about.

Before you start:

- Put a wallet key in `.env.local` as `SOLANA_PRIVATE_KEY` (never paste it into a chat). It only needs to read in parts A and B. In part C it pays, so use a wallet holding only what you plan to spend.
- Remove `GIBWORK_ENV=stage` from `.env.local` if it is there, so `attach` and `check` use production, where gibwork.com bounties live.
- Work in a scratch folder, so the `.gibreview/` state from this run stays separate.

## A. Free: read an existing bounty (no money moves)

Pick any open bounty on gibwork.com and find its task id.

1. `gibreview attach <taskId> --brief examples/review/content-brief.yaml`
   - Expect: the pool shown matches the website (question 7, the units of the amount), and the minimum per approved submission matches the bounty page.
   - Expect: "This bounty belongs to a Gibwork account wallet…", since you did not create it.
   - If it fails to authenticate, note the error: it tells us whether a wallet that has no Gibwork account can read through the API.
2. `gibreview collect`, then `gibreview rank`
   - Expect: either the submissions, or an error saying only the creator can list them (question 5, visibility). Note which.
3. Save a draft as `draft.txt` and run `gibreview check <taskId> draft.txt`
   - Expect: "This bounty does not list gibreview rules", since it was written by hand. With `--brief examples/review/content-brief.yaml` the checks run.

## B. A real website bounty (smallest amount, $50)

1. `gibreview text examples/review/content-brief.yaml` (pool $50: 25 / 15 / 10, minimum $10). Create the bounty on gibwork.com exactly as it says, paying from your Gibwork account wallet.
   - Expect: the preview shows "Minimum $10 per approved submission", and the description keeps one line per rule.
2. `gibreview attach <taskId> --brief examples/review/content-brief.yaml`
   - Expect: no rule warning (the pasted rules match the brief), pool 50.00, minimum 10.00, and the website checklist mode.
3. Ask two or three people to submit: one good, one with a dead link (`https://dev.to/anything-404`), one without the SUBMISSION block. Before submitting, they run `gibreview check <taskId> their-draft.txt`.
   - Expect: the pre-check reads the rules from the bounty (rules from the bounty, not the brief).
4. `gibreview collect`, `gibreview rank`, `gibreview decide`
   - Expect: the good one is paid 25.00 (1st place), the dead link gets a fix request, the one without the block is rejected.
5. Do the checklist on gibwork.com, then `gibreview decide --mark-done --confirm <code>`.
6. Ask the participant with the dead link to fix it as the comment says.
   - Note how they could: a reply, an edit, or only a new submission (question 3).
   - Then `gibreview collect --recheck` and `gibreview decide`. Expect: the fixed one takes 2nd place at 15.00.
7. After approving on the website, `gibreview collect` and `gibreview status`.
   - Note the Gibwork status each approved submission shows (question 4). Anything gibreview does not recognise is held, never guessed.
8. Close the bounty on gibwork.com and refund what is left, as `gibreview close` says.

## C. A bounty created from code (optional, stage)

Only if you want gibreview to pay by itself. The wallet in `SOLANA_PRIVATE_KEY` funds and owns this bounty.

1. `gibreview publish examples/review/dev-brief.yaml` shows the cost; add `--confirm` to fund it.
   - Note whether stage accepts the pool and what it rejects (question 1), and whether the USDC that moved is real (question 6).
2. After submissions: `gibreview decide`, then `gibreview decide --apply --confirm <code>`.
   - Expect: payment goes through, and a second winner can still be paid after the first (question 2).
3. `gibreview close --confirm` refunds the rest.

## After the run

Update the simulator (`src/mock.ts`) to match anything that differed, such as status names, amount units or who can list submissions, so the tests keep matching Gibwork. Then mark M5 done in [plan.md](plan.md).
