#!/bin/bash
# The law gate (owner, 26.09.2026): the files that decide stages, qualification, what the bot asks
# and the sending limits reach production only with the owner's word. A deploy that changes any of
# them is refused unless every commit touching them says "Approved by owner <date>" in its message.
# Usage: law-gate.sh <from-ref> <to-ref>   (exit 1 = refused)
from="$1"; to="$2"
cd /opt/whatcan || exit 1
LAW='^skills/|artifacts/api-server/src/lib/(listing-card-fields|listing-stage-engine|listing-acquisition-prompt|listing-owner-followup|new-contact-budget|stage-classifier|thread-stage-sync|stage-on-reply|stage-routing|rental-prompt|weekly-availability-check|autopilot|inspection-booking|listing-progress)\.ts$'
changed=$(git diff --name-only "$from" "$to" | grep -E "$LAW")
[ -z "$changed" ] && exit 0
bad=0
for f in $changed; do
  # every commit in the range that touches this file must carry the owner's approval
  for c in $(git log --format=%H "$from..$to" -- "$f"); do
    if ! git log -1 --format=%B "$c" | grep -qi "approved by owner"; then
      echo "LAW GATE: $f changed in $(git log -1 --format='%h %s' "$c" | cut -c1-90) — no 'Approved by owner <date>' in the commit"
      bad=1
    fi
  done
done
if [ "$bad" = 1 ]; then
  echo "LAW GATE: deploy refused. These files are the funnel's law (skills/*.md and the stage/qualification/ask/limit code)."
  echo "LAW GATE: get the owner's 'yes' in chat, then commit with 'Approved by owner DD.MM.YYYY' in the message."
  exit 1
fi
echo "LAW GATE: law files changed with the owner's approval: $(echo $changed | tr '\n' ' ')"
exit 0
