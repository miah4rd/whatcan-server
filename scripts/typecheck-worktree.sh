#!/bin/bash
# Honest tsc typecheck of github/master on the whatcan server, in a throwaway
# worktree at /tmp/tc. esbuild (pnpm run build) does not typecheck, and tsc
# inside /opt/whatcan itself explodes on the never-built lib/db dist (TS6305).
#
# Run on the server AFTER `git push origin master` and BEFORE ./deploy.sh:
#   bash /opt/whatcan/scripts/typecheck-worktree.sh   (or the copy in /root/bin)
# Exit 1 when any error lands in a file that github/master changes against the
# running prod HEAD. Errors elsewhere are the known baseline (~10) and are only
# summarised.
set -u
TSC=/opt/whatcan/node_modules/.bin/tsc
cd /opt/whatcan || exit 1
git fetch github -q || { echo "FETCH FAILED"; exit 1; }
# Remove the directory FIRST, then prune — prune only forgets a worktree
# whose directory is already gone.
rm -rf /tmp/tc
git worktree prune
git worktree add --detach /tmp/tc github/master -q || { echo "WORKTREE FAILED"; exit 1; }

# node_modules: a REAL directory with every prod entry linked, except
# @workspace — those must resolve to the worktree's own lib/* (a column added
# in this push lives there, not in prod's still-old src).
link_nm() {
  [ -d "$1/node_modules" ] || return 0
  mkdir -p "$2/node_modules"
  for e in "$1"/node_modules/* "$1"/node_modules/.bin "$1"/node_modules/.pnpm; do
    [ -e "$e" ] || continue
    n=$(basename "$e")
    [ "$n" = "@workspace" ] && continue
    ln -s "$e" "$2/node_modules/$n" 2>/dev/null
  done
  if [ -d "$1/node_modules/@workspace" ]; then
    mkdir -p "$2/node_modules/@workspace"
    for d in "$1"/node_modules/@workspace/*; do
      [ -e "$d" ] || continue
      t=$(readlink -f "$d")
      ln -s "/tmp/tc${t#/opt/whatcan}" "$2/node_modules/@workspace/$(basename "$d")" 2>/dev/null
    done
  fi
}
link_nm /opt/whatcan /tmp/tc
link_nm /opt/whatcan/artifacts/api-server /tmp/tc/artifacts/api-server
link_nm /opt/whatcan/scripts /tmp/tc/scripts
for d in /opt/whatcan/lib/*; do [ -d "$d" ] && link_nm "$d" "/tmp/tc/lib/$(basename "$d")"; done

cd /tmp/tc/artifacts/api-server || exit 1
# api-server reads lib/* types from their dist (project references) — build them first.
for p in ../../lib/db ../../lib/api-zod ../../lib/api-spec; do
  [ -d "$p" ] && "$TSC" -b "$p" >/dev/null 2>&1
done
"$TSC" --noEmit -p tsconfig.json > /tmp/tc-errors.txt 2>&1
total=$(grep -c "error TS" /tmp/tc-errors.txt)
# The gate: an error is NEW when its file + code + message (line numbers
# stripped — they drift with every edit above them) is not in the recorded
# baseline. /root/bin/tsc-baseline.txt holds the ~10 errors in files nobody
# touches; refresh it deliberately with --save-baseline after fixing one.
BASE=/root/bin/tsc-baseline.txt
strip() { grep "error TS" "$1" | sed -E 's/\([0-9]+,[0-9]+\)//' | sort -u; }
if [ "${1:-}" = "--save-baseline" ]; then strip /tmp/tc-errors.txt > "$BASE"; echo "baseline saved: $(wc -l < "$BASE") errors"; exit 0; fi
[ -f "$BASE" ] || { echo "no baseline at $BASE — run with --save-baseline on a known-good tree first"; exit 1; }
strip /tmp/tc-errors.txt > /tmp/tc-now.txt
comm -23 /tmp/tc-now.txt "$BASE" > /tmp/tc-new.txt
echo "tsc: $total errors total, $(wc -l < "$BASE") in baseline, $(wc -l < /tmp/tc-new.txt) new"
if [ -s /tmp/tc-new.txt ]; then
  echo "NEW TYPE ERRORS (not in baseline):"; cat /tmp/tc-new.txt; exit 1
fi
echo "no new type errors."
exit 0
