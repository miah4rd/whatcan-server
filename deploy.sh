#!/bin/bash
# The ONLY way to deploy. Build first; restart ONLY if the build succeeded.
# A failed esbuild leaves no dist/index.mjs, and a pm2 restart on top of that is
# a crash loop, i.e. a full outage — which is exactly what a hand-typed chain
# with the build piped through `tail` produced on 2026-09-05 (build failure
# masked by tail's exit code, pm2 restarted, 202 crashes, ~15 minutes down).
set -o pipefail
cd /opt/whatcan || exit 1
git fetch github -q && git merge github/master --no-edit -q || { echo "MERGE FAILED"; exit 1; }
cd artifacts/api-server || exit 1
[ -s dist/index.mjs ] && cp dist/index.mjs dist/index.prev.mjs
if ! pnpm run build > /tmp/build.log 2>&1; then
  echo "BUILD FAILED - pm2 NOT restarted, old bundle keeps running"; tail -12 /tmp/build.log; exit 1
fi
[ -s dist/index.mjs ] || { echo "BUILD PRODUCED NO dist/index.mjs - pm2 NOT restarted"; exit 1; }
cd /opt/whatcan && pm2 restart ecosystem.config.cjs --update-env >/dev/null 2>&1 && pm2 save >/dev/null 2>&1
sleep 6
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:5000/api/public/autopilot?pipeline=rental%20listings')
status=$(pm2 jlist | python3 -c 'import sys,json;print([p["pm2_env"]["status"] for p in json.load(sys.stdin) if p["name"]=="whatcan"][0])')
# The /m page is one JS string inside a template literal; a stray quote or a
# collapsed backslash takes the whole broker UI down while the API stays 200.
# Parse the served script; on failure put the previous bundle back and restart.
pagecheck=$(curl -s -m 20 http://127.0.0.1:5000/m | node /opt/whatcan/scripts/check-mobile-page.js)
if [ "$pagecheck" != "ok" ] && [ -s artifacts/api-server/dist/index.prev.mjs ]; then
  cp artifacts/api-server/dist/index.prev.mjs artifacts/api-server/dist/index.mjs
  pm2 restart ecosystem.config.cjs --update-env >/dev/null 2>&1
  echo "MOBILE PAGE BROKEN ($pagecheck) - previous bundle restored, NOT deployed"; exit 1
fi
echo "deployed: api HTTP $code, pm2 $status, /m page $pagecheck"
[ "$code" = "200" ] && [ "$status" = "online" ] || exit 1
