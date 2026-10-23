#!/usr/bin/env bash
# Updates this checkout to the tip of its branch and restarts the API under pm2. Run on the server:
#
#   bash deploy/deploy.sh
#
# Steps: git pull --ff-only, npm ci, npm run build, pm2 startOrReload ecosystem.config.js, then wait
# for GET /health. Nothing else: no release folders, no cleaning of untracked files, so the SQLite
# database under data/ (gitignored) and .env are never touched.
#
# Moving to another server: clone the repo, copy .env (and data/ if the history matters), run this
# script once, then `pm2 startup` + `pm2 save` so it comes back after a reboot. Node 18+ and pm2.
set -euo pipefail

cd "$(dirname "$0")/.."

# PORT from .env the way dotenv reads it; 8080 when unset.
port="$( { grep -E '^(export[[:space:]]+)?PORT=' .env 2>/dev/null || true; } | tail -n1 | tr -d '\r' | sed -E 's/^.*PORT=[[:space:]]*"?([0-9]+).*$/\1/')"
port="${port:-8080}"

echo "==> Updating $(git branch --show-current)"
git pull --ff-only

echo "==> Installing dependencies"
npm ci --no-audit --no-fund

echo "==> Building"
npm run build

echo "==> Restarting under pm2"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo "==> Waiting for the API on :$port"
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:$port/health"; then
    echo "memoless-api is up on :$port at $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done
echo "memoless-api did not answer on :$port within 60s" >&2
pm2 logs memoless-api --lines 50 --nostream || true
exit 1
