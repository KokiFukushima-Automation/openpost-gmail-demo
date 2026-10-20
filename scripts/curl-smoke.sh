#!/usr/bin/env bash
# Manual verification steps from docs/04_phase1_spec.md §5 ("Manual verification (curl)").
#
# Usage: run step 0-1 to build+send, then in a SEPARATE shell run `node dist/cli/index.js serve`,
# then run this script's remaining steps (or just re-run this whole script after starting the
# server in the background - see the bottom of the file for a self-contained variant).
set -euo pipefail
cd "$(dirname "$0")/.."

export TRACKING_SECRET="${TRACKING_SECRET:-$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")}"
export TRACKING_BASE_URL="${TRACKING_BASE_URL:-http://127.0.0.1:8787}"
export FROM_EMAIL="${FROM_EMAIL:-you@example.com}"
export DB_PATH="${DB_PATH:-./data/openpost.db}"
export OUT_DIR="${OUT_DIR:-./out}"

echo "== 0) build + init =="
npm run build
node dist/cli/index.js init

echo "== 1) dry-run send =="
SEND_JSON=$(node dist/cli/index.js send --to alice@example.com \
  --subject "hello" --html '<p>Hi <a href="https://example.com/x?a=1#f">link</a></p>' \
  --track-clicks --dry-run --json)
echo "$SEND_JSON" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
MESSAGE_ID=$(echo "$SEND_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).messageId))")
echo "messageId=$MESSAGE_ID"

echo "== 2) start the server in the background =="
node dist/cli/index.js serve &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1

echo "== 3) health =="
curl -s http://127.0.0.1:8787/healthz | tee /dev/stderr | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d); if(!j.ok) process.exit(1);})"

echo "== 4) the pixel: expect 200, image/gif, 43 bytes, no-store, no ETag =="
SHOW_JSON=$(node dist/cli/index.js show "$MESSAGE_ID" --json)
PIXEL=$(echo "$SHOW_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).recipients[0].pixelUrl))")
echo "pixel=$PIXEL"
curl -s -D - -o /dev/null "$PIXEL"

echo "== 5) immediately after send it must NOT count (R1); wait then repeat =="
sleep 11
curl -s -o /dev/null "$PIXEL"

echo "== 6) simulate the Gmail image proxy (human + device=proxy after the window) =="
curl -s -o /dev/null -A "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)" "$PIXEL"

echo "== 7) simulate a scanner (expect classification=bot, counted=0) =="
curl -s -o /dev/null -A "python-requests/2.32.0" "$PIXEL"

echo "== 8) tampered token -> still 200 + GIF, but no event =="
curl -s -D - -o /dev/null "${PIXEL%.gif*}X.gif"

echo "== 9) click redirect: expect 302 to the exact original URL =="
CLICK=$(echo "$SHOW_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).recipients[0].links[0].clickUrl))")
echo "click=$CLICK"
curl -s -D - -o /dev/null "$CLICK"

echo "== 10) inspect =="
node dist/cli/index.js show "$MESSAGE_ID" --events

echo "== done =="
