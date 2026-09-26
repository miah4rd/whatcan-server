#!/bin/bash
# Morning regulation audit (owner, 26.09.2026): every change to a regulation or to the code that
# enforces it in the last 24 h, with or without the owner's approval, plus the live settings the
# owner controls. Printed; the api server sends it to the owner when something changed.
cd /opt/whatcan || exit 1
LAW=$(grep -o "LAW='[^']*'" scripts/law-gate.sh | sed "s/^LAW='//;s/'$//")
since="${1:-24 hours ago}"
echo "Regulation audit — changes since $since"
found=0
for c in $(git log --since="$since" --format=%H HEAD); do
  files=$(git show --name-only --format= "$c" | grep -E "$LAW" || true)
  [ -z "$files" ] && continue
  found=1
  ok="NO APPROVAL"; git log -1 --format=%B "$c" | grep -qi "approved by owner" && ok="approved"
  echo "• $(git log -1 --format='%ad %s' --date=format:%d.%m\ %H:%M "$c" | cut -c1-80) [$ok]"
  for f in $files; do echo "    $f"; done
done
[ "$found" = 0 ] && echo "• no law files changed"
exit 0
