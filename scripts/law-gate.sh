#!/bin/bash
# The law gate (owner, 26.09.2026): the files that decide stages, qualification, what the bot asks
# and the sending limits reach production only with the owner's word. A deploy that changes any of
# them is refused unless every commit touching them says "Approved by owner <date>" in its message.
# Usage: law-gate.sh <from-ref> <to-ref>   (exit 1 = refused)
from="$1"; to="$2"
cd /opt/whatcan || exit 1
LAW='^skills/|^scripts/law-gate\.sh$|^scripts/regulation-audit\.sh$|^wa-gateway/index\.mjs$|artifacts/api-server/src/lib/(listing-card-fields|listing-stage-engine|listing-acquisition-prompt|listing-owner-followup|listing-progress|listing-status-pass|listing-referral|long-term-check|inspection-booking|weekly-availability-check|weekly-check-reply|new-contact-budget|autopilot|stage-classifier|stage-routing|stage-on-reply|thread-stage-sync|rental-prompt|sales-prompt|generate-suggestion|followup-scheduler|rental-followup|ad-lead-autoreply|excluded-area-filter|budget-filter|area-coverage|property-catalog|pending-visibility|outbound-send|broker-corrections|accepted-examples|viewing-report|inspection-report|amo-sync)\.ts$|artifacts/api-server/src/routes/(amocrm-webhook|public/approve|public/suggest|public/autopilot)\.ts$'
changed=$(git diff --name-only "$from" "$to" | grep -E "$LAW")
[ -z "$changed" ] && exit 0
bad=0
for f in $changed; do
  # every commit in the range that touches this file must carry the owner's approval
  for c in $(git log --format=%H "$from..$to" -- "$f"); do
    # A save in Unicorn OS Playbooks by the owner or a manager is an approval too (owner, 26.09: "as in Cowork").
    if ! git log -1 --format=%B "$c" | grep -qiE "approved by owner|approved in unicorn os by"; then
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
