#!/usr/bin/env bash
# Apply the 2026-11-19 pivot to the GitHub issues.
#
#   bash .github/issues/2026-11-19-pivot/apply.sh
#
# Needs the `gh` CLI authenticated with issue-write access. Safe to re-run:
# every edit overwrites title/body with the same content, and the two creates
# skip if an issue with that title already exists.

set -euo pipefail
cd "$(dirname "$0")"

edit() {
  local issue=$1 title=$2 file=$3
  echo "editing #$issue — $title"
  gh issue edit "$issue" --title "$title" --body-file "$file" >/dev/null
}

create() {
  local title=$1 labels=$2 file=$3
  if gh issue list --state all --search "in:title $title" --json title \
      --jq '.[].title' | grep -qxF "$title"; then
    echo "skipping (exists): $title"
    return
  fi
  echo "creating — $title"
  gh issue create --title "$title" --label "$labels" --body-file "$file" >/dev/null
}

edit 12 "F12: Seed and validate the visual brief bank"                       01-f12.md
edit 14 "F14: Implement deterministic checks and artifact evaluation"        02-f14.md
edit 15 "F15: Define render failure, tie, and void behavior"                 03-f15.md
edit 17 "F17: Orchestrate the chunked generation and render pipeline"        04-f17.md
edit 18 "F18: Implement parimutuel scoring and idempotent settlement"        05-f18.md
edit 19 "F19: Build the results and replay view"                             06-f19.md

create "F31: Integrate the judge model for conformance rulings" \
  "area:llm,area:evaluation,priority:p0,requirements" 07-f31.md
create "F32: Add crowd voting for the fan-favorite result" \
  "area:competition,area:frontend,priority:p1,requirements" 08-f32.md

echo
echo "Done. Verify with: gh issue list --state open --limit 50"
