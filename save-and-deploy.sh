#!/bin/bash
echo "=== What-Can Deploy ==="
cd "$(dirname "$0")"
git add -A
git commit -m "update: $(date)"
git push origin master
ssh whatcan "cd /opt/whatcan && git pull github master && cd artifacts/api-server && node build.mjs && pm2 restart whatcan"
echo "=== Done! ==="
