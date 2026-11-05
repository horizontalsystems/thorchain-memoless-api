#!/usr/bin/env bash
# Updates this checkout to the tip of its branch and restarts the API under pm2. Run on the server:
#
#   bash deploy/deploy.sh
#   GIT_SHA=<sha> bash deploy/deploy.sh     # move forward to an exact commit of origin (fast-forward only)
#   bash -s < deploy/deploy.sh              # the same from stdin, run inside the checkout
#
# Steps: git pull --ff-only, npm ci, npm run build, pm2 startOrReload ecosystem.config.js, then wait
# for GET /health. Nothing else: no release folders, no cleaning of untracked files, so the SQLite
# database under data/ (gitignored) and .env are never touched.
#
# Moving to another server: clone the repo, copy .env (and data/ if the history matters), run this
# script once, then `pm2 startup` + `pm2 save` so it comes back after a reboot. Node 18+ and pm2.
set -euo pipefail

# From a file: its checkout. From stdin (`bash -s`, no file): the current directory.
if [ -f "${BASH_SOURCE[0]:-}" ]; then cd "$(dirname "${BASH_SOURCE[0]}")/.."; fi

# npm audit of the production dependencies, as a summary in the deploy log. It fails the deploy only at
# or above NPM_AUDIT_FAIL_LEVEL (low|moderate|high|critical; unset: never), because on 2026-11-04 every
# repository had open advisories and a deploy must still be able to ship their fixes. A registry that
# cannot be reached is reported and skipped.
audit_dependencies() {
  local report
  report="$(npm audit --omit=dev --json 2>/dev/null || true)"   # non-zero whenever anything is found
  printf '%s' "$report" | node -e '
    let d = ""
    process.stdin.on("data", c => (d += c)).on("end", () => {
      let r
      try { r = JSON.parse(d) } catch {}
      const m = r && r.metadata && r.metadata.vulnerabilities
      if (!m) { console.log("npm audit gave no report (registry unreachable?)"); return }
      const named = s => Object.values(r.vulnerabilities || {}).filter(v => v.severity === s).map(v => v.name).join(", ")
      console.log(`critical ${m.critical || 0}, high ${m.high || 0}, moderate ${m.moderate || 0}, low ${m.low || 0}`)
      if (m.critical) console.log(`critical: ${named("critical")}`)
      const order = ["low", "moderate", "high", "critical"]
      const fail = process.env.NPM_AUDIT_FAIL_LEVEL
      if (!fail) return
      if (!order.includes(fail)) { console.error(`NPM_AUDIT_FAIL_LEVEL=${fail} is not one of ${order.join("|")}`); process.exit(1) }
      if (order.slice(order.indexOf(fail)).some(s => m[s] > 0)) { console.error(`npm audit: findings at or above ${fail}`); process.exit(1) }
    })'
}

main() {
  # PORT from .env the way dotenv reads it; 8080 when unset.
  port="$( { grep -E '^(export[[:space:]]+)?PORT=' .env 2>/dev/null || true; } | tail -n1 | tr -d '\r' | sed -E 's/^.*PORT=[[:space:]]*"?([0-9]+).*$/\1/')"
  port="${port:-8080}"

  echo "==> Updating $(git branch --show-current)"
  if [ -n "${GIT_SHA:-}" ]; then
    git fetch origin
    git merge --ff-only "$GIT_SHA"
  else
    git pull --ff-only
  fi

  echo "==> Installing dependencies"
  npm ci --no-audit --no-fund

  echo "==> Auditing production dependencies"
  audit_dependencies

  echo "==> Building"
  npm run build

  echo "==> Restarting under pm2"
  pm2 startOrReload ecosystem.config.js --update-env
  pm2 save

  echo "==> Waiting for the API on :$port"
  for _ in $(seq 1 30); do
    if curl -fs -o /dev/null "http://127.0.0.1:$port/health"; then
      echo "memoless-api is up on :$port at $(git rev-parse --short HEAD)"
      return 0
    fi
    sleep 2
  done
  echo "memoless-api did not answer on :$port within 60s" >&2
  pm2 logs memoless-api --lines 50 --nostream || true
  return 1
}

# Inside main() with stdin closed: from `bash -s`, bash reads the script from stdin as it runs, and a
# command that reads stdin would eat the rest of it.
main "$@" </dev/null
