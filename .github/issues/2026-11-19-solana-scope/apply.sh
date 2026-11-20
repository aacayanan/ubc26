#!/usr/bin/env bash
# Apply the 2026-11-19 G1 Solana-scope decision to the GitHub issues.
#
#   bash .github/issues/2026-11-19-solana-scope/apply.sh
#
# Needs the `gh` CLI authenticated with issue-write access. Safe to re-run:
# every edit overwrites the title and body with the same content, and the close
# step is skipped once #20 is already closed (so the decision comment is not
# posted twice).

set -euo pipefail
cd "$(dirname "$0")"

edit() {
  local issue=$1 title=$2 file=$3
  echo "editing #$issue — $title"
  gh issue edit "$issue" --title "$title" --body-file "$file" >/dev/null
}

edit 21 "F20: Record and verify prediction commitments on Solana Devnet" 01-f20.md
edit 22 "F21: Record round IDs and deadlines on-chain"                  02-f21.md
edit 23 "F22: Record settlement events on-chain"                        03-f22.md
edit 24 "F23: Document blockchain guarantees and limitations"           04-f23.md

if [ "$(gh issue view 20 --json state --jq .state)" = "OPEN" ]; then
  echo "closing #20 — G1: Decide and document the Solana integration scope"
  gh issue close 20 --comment "$(cat 00-g1-decision.md)" >/dev/null
else
  echo "skipping #20 — already closed (its decision comment is on the issue)"
fi

echo
echo "Done. Verify with: gh issue view 20,21,22,23,24"
