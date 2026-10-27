#!/usr/bin/env bash
# Full gibreview walkthrough against the offline simulator. Good for a screen recording.
# Usage: npm run demo        (or: bash examples/demo.sh)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BB="node $ROOT/dist/review/cli.js qa"
cd "$WORK"

step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; sleep "${DEMO_PAUSE:-1}"; }

step "gibreview qa generate <feature url> --out draft.yaml"; $BB generate https://staging.acme-shop.example/checkout --html "$ROOT/examples/fixtures/checkout.html" --out draft.yaml --no-ai
step "gibreview qa plan draft.yaml   (refused until reviewed)"; $BB plan draft.yaml --mock
step "gibreview qa init testplan.yaml   (a reviewed plan)"; $BB init testplan.yaml
step "gibreview qa plan testplan.yaml --mock";       $BB plan testplan.yaml --mock
step "gibreview qa plan testplan.yaml --mock --show ios-safari-1"; $BB plan testplan.yaml --mock --show ios-safari-1 | sed -n '/^\[QA\]/,$p' | head -60
step "gibreview qa publish --confirm";               $BB publish --confirm
step "gibreview qa collect";                         $BB collect
step "gibreview qa triage";                          $BB triage
step "gibreview qa triage --apply";                  $BB triage --apply > /dev/null && $BB status
step "gibreview qa report";                          $BB report; code=$?
printf '\nExit code %s (0 pass, 1 release blocked, 2 coverage gaps)\n' "$code"
step "head -40 qa-report/report.md";       head -40 qa-report/report.md
printf '\nWorking directory %s\n' "$WORK"
