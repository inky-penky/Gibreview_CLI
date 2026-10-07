#!/usr/bin/env bash
# Full BugBash walkthrough against the offline simulator. Good for a screen recording.
# Usage: npm run demo        (or: bash examples/demo.sh)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BB="node $ROOT/dist/cli.js"
cd "$WORK"

step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; sleep "${DEMO_PAUSE:-1}"; }

step "bugbash generate <feature url> --out draft.yaml"; $BB generate https://staging.acme-shop.example/checkout --html "$ROOT/examples/fixtures/checkout.html" --out draft.yaml --no-ai
step "bugbash plan draft.yaml   (refused until reviewed)"; $BB plan draft.yaml --mock
step "bugbash init testplan.yaml   (a reviewed plan)"; $BB init testplan.yaml
step "bugbash plan testplan.yaml --mock";       $BB plan testplan.yaml --mock
step "bugbash plan testplan.yaml --mock --show ios-safari-1"; $BB plan testplan.yaml --mock --show ios-safari-1 | sed -n '/^\[QA\]/,$p' | head -60
step "bugbash publish --confirm";               $BB publish --confirm
step "bugbash collect";                         $BB collect
step "bugbash triage";                          $BB triage
step "bugbash triage --apply";                  $BB triage --apply > /dev/null && $BB status
step "bugbash report";                          $BB report; code=$?
printf '\nExit code %s (0 pass, 1 release blocked, 2 coverage gaps)\n' "$code"
step "head -40 bugbash-report/report.md";       head -40 bugbash-report/report.md
printf '\nWorking directory %s\n' "$WORK"
