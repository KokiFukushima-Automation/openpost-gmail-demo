#!/usr/bin/env bash
# Manual verification steps from docs/05_phase2_spec.md §7.6 ("Manual verification (curl)").
# Self-contained: builds, starts a fake webhook receiver + the tracking server in the background,
# and exercises notifications, click tracking + back-fill, accuracy, doctor and forget end to end.
#
# Usage: ./scripts/curl-smoke-phase2.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WORKDIR=$(mktemp -d)
trap 'kill ${SERVER_PID:-0} ${RECEIVER_PID:-0} 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

export TRACKING_SECRET="${TRACKING_SECRET:-$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")}"
export TRACKING_BASE_URL="${TRACKING_BASE_URL:-http://127.0.0.1:8787}"
export FROM_EMAIL="${FROM_EMAIL:-you@example.com}"
export DB_PATH="$WORKDIR/openpost.db"
export OUT_DIR="$WORKDIR/out"
export WEBHOOK_URL="http://127.0.0.1:9099/hook"
export WEBHOOK_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
# Phase 2.1 (finding #9): WEBHOOK_URL above is deliberately loopback (the fake receiver started
# below) - opt in explicitly rather than have loadConfig reject it as a private-network URL.
export NOTIFY_ALLOW_PRIVATE_URLS=true
export NOTIFY_CHANNELS=webhook
export NOTIFY_ON=first_open,read_confirmed,click
export NOTIFY_TICK_SECONDS=1
export OPEN_IGNORE_SECONDS=1

echo "== 0) build + migrate =="
npm run build
node dist/cli/index.js migrate --json

echo "== 1) start the fake webhook receiver =="
node scripts/fake-receiver.mjs 9099 > "$WORKDIR/receiver.log" 2>&1 &
RECEIVER_PID=$!
sleep 0.3

echo "== 2) send (click tracking is on by default) =="
SEND_JSON=$(node dist/cli/index.js send --to alice@example.com --subject "hello" \
  --html '<p>Hi <a href="https://example.com/x?a=1#f">link</a></p>' --dry-run --json)
echo "$SEND_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
MESSAGE_ID=$(echo "$SEND_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).messageId))")

echo "== 3) start the tracking server =="
node dist/cli/index.js serve > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:8787/healthz"; then break; fi
  sleep 0.25
done

echo "== 3b) SSE stream sanity (background, 4s) =="
(timeout 4 curl -sN "http://127.0.0.1:8787/api/events/stream" || true) > "$WORKDIR/sse.log" &
sleep 1.5

echo "== 4) a human-looking open after the ignore window =="
SHOW_JSON=$(node dist/cli/index.js show "$MESSAGE_ID" --json)
PIXEL=$(echo "$SHOW_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).recipients[0].pixelUrl))")
CLICK=$(echo "$SHOW_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).recipients[0].links[0].clickUrl))")
curl -s -o /dev/null -D - -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" \
     -H 'Accept: image/avif,image/webp,*/*' "$PIXEL"

echo "== 5) click -> exact original URL =="
curl -s -D - -o /dev/null "$CLICK"

echo "== waiting for the notify worker tick =="
sleep 2

echo "== 6) notification bookkeeping =="
node dist/cli/index.js notifications list --json

echo "== 7) accuracy + doctor + ranges =="
node dist/cli/index.js accuracy --since 1d --json
node dist/cli/index.js doctor --url http://127.0.0.1:8787 --json
node dist/cli/index.js update-ranges --source apple --from-file tests/fixtures/apple-egress.csv --out-dir "$WORKDIR/ranges" --dry-run --json

echo "== 8) privacy =="
node dist/cli/index.js forget alice@example.com --dry-run --json
node dist/cli/index.js forget alice@example.com --yes --json
curl -s -o /dev/null -D - "$PIXEL"   # still 200 + 43-byte GIF, zero events, one token.orphan

echo "== receiver log (VALID/INVALID deliveries) =="
cat "$WORKDIR/receiver.log"

echo "== SSE frames captured =="
cat "$WORKDIR/sse.log"

echo "== done =="
