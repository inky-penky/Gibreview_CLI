#!/usr/bin/env bash
# gibreview's review flow against the offline simulator, from brief to payout. Good for a screen recording.
# Usage: npm run demo:review        (or: bash examples/review-demo.sh [output dir])
# With an output dir, review.md and review.json are copied there when the run ends.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-}"
[ -n "$OUT" ] && OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
GR="node $ROOT/dist/review/cli.js"
BRIEF=content-brief.yaml
cd "$WORK"
cp "$ROOT/examples/review/content-brief.yaml" "$BRIEF"

step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; sleep "${DEMO_PAUSE:-1}"; }

step "gibreview text content-brief.yaml   (the bounty text and what to pick on gibwork.com)"; $GR text "$BRIEF" --out bounty.description.txt
step "gibreview publish content-brief.yaml --mock   (shows the cost, moves nothing)"; $GR publish "$BRIEF" --mock
step "gibreview publish content-brief.yaml --mock --confirm"; $GR publish "$BRIEF" --mock --confirm
TASK="$($GR status | sed -n 's/^ *task \([^ ]*\).*/\1/p')"

cp "$ROOT/examples/review/draft-bad.txt" "$ROOT/examples/review/draft-good.txt" .
step "cat draft-bad.txt"; cat draft-bad.txt
step "gibreview check <taskId> draft-bad.txt --mock   (participant pre-check, free)"; $GR check "$TASK" draft-bad.txt --mock
printf '\nExit code %s (0 ready to submit)\n' "$?"
step "gibreview check <taskId> draft-good.txt --mock"; $GR check "$TASK" draft-good.txt --mock
printf '\nExit code %s (0 ready to submit)\n' "$?"

step "gibreview collect   (fetch every submission and run the checks)"; $GR collect
step "gibreview rank"; $GR rank
step "gibreview show @copycat"; $GR show @copycat
step "gibreview decide   (dry run: who is paid, asked to fix or rejected)"; $GR decide
CODE="$($GR decide | sed -n 's/.*--confirm \([^ ]*\).*/\1/p')"
step "gibreview decide --apply --confirm $CODE"; $GR decide --apply --confirm "$CODE"
step "gibreview close --confirm   (refunds what nobody won)"; $GR close --confirm
step "gibreview status"; $GR status
step "head -40 review-report/review.md"; head -40 review-report/review.md

[ -n "$OUT" ] && cp review-report/review.md review-report/review.json "$OUT"/
printf '\nWorking directory %s\n' "$WORK"
