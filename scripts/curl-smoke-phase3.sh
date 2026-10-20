#!/usr/bin/env bash
# Phase 3 manual verification (docs/06_phase3_spec.md sec 6.6), adapted to what actually shipped.
# Run from the repo root after `npm run build`. Entirely offline: dryrun transport, no Gmail
# credentials, no public URL.
set -euo pipefail

WORKDIR="$(mktemp -d)"
trap 'kill "${SERVE_PID:-0}" 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

export TRACKING_SECRET="$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")"
export TRACKING_BASE_URL="http://127.0.0.1:18787"
export DB_PATH="$WORKDIR/openpost.db"
export DASHBOARD_PASSWORD="letmein"
export MAIL_TRANSPORT="dryrun"
export PORT=18787
export BIND_ADDRESS=127.0.0.1

CLI="node dist/cli/index.js"

echo "== 0) build, migrate, seed =="
$CLI migrate --json
$CLI seed --demo --reset --json

echo "== 1) serve, log in, keep the cookie jar =="
$CLI serve > "$WORKDIR/serve.log" 2>&1 &
SERVE_PID=$!
for i in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:18787/healthz" && break
  sleep 0.1
done
curl -s -c "$WORKDIR/jar.txt" -o /dev/null -w 'login=%{http_code}\n' \
     -d 'password=letmein' http://127.0.0.1:18787/dashboard/login

echo "== 2) the list, a detail page, and the CSP header =="
curl -s -b "$WORKDIR/jar.txt" -D - -o /dev/null http://127.0.0.1:18787/dashboard/messages | grep -i content-security
curl -s -b "$WORKDIR/jar.txt" "http://127.0.0.1:18787/dashboard/messages?q=recipient0" | grep -c '<tr data-message-id' || true

echo "== 3) live update: pixel hit, then re-fetch the fragment =="
MSGID="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
console.log(db.prepare('SELECT r.id AS rid, r.token AS token FROM recipients r WHERE r.sent_at IS NOT NULL LIMIT 1').get().rid);
")"
PIXEL="$($CLI show "$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
console.log(db.prepare('SELECT message_id FROM recipients WHERE id = ?').get('$MSGID').message_id);
")" --json | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  const o = JSON.parse(d);
  const r = o.recipients.find(x => x.id === '$MSGID');
  console.log(r.pixelUrl);
});")"
curl -s -o /dev/null -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36" "$PIXEL"
sleep 0.3
curl -s -b "$WORKDIR/jar.txt" "http://127.0.0.1:18787/dashboard/fragments/recipient/$MSGID"

echo
echo "== 4) two-click override, then the audit view =="
CSRF="$(grep openpost_csrf "$WORKDIR/jar.txt" | awk '{print $7}')"
BOT_EVENT="$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
console.log(db.prepare(\"SELECT id FROM open_events WHERE classification = 'bot' LIMIT 1\").get().id);
")"
curl -s -b "$WORKDIR/jar.txt" -X POST -d "kind=open&eventId=$BOT_EVENT&classification=human&_csrf=$CSRF" \
     http://127.0.0.1:18787/dashboard/actions/reclassify -o /dev/null -w 'override=%{http_code}\n'
curl -s -b "$WORKDIR/jar.txt" 'http://127.0.0.1:18787/dashboard/audit?action=reclassify.override' | grep -c 'bot' || true

echo "== 5) export + stats =="
curl -s -b "$WORKDIR/jar.txt" -o "$WORKDIR/out.csv" 'http://127.0.0.1:18787/dashboard/export.csv?state=read_confirmed'
wc -l "$WORKDIR/out.csv"
$CLI stats --since 30d --tz Europe/Berlin

echo "== 6) reminders (offline: dryrun transport, no --draft) =="
$CLI remind "$(node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
console.log(db.prepare('SELECT message_id FROM recipients WHERE id = ?').get('$MSGID').message_id);
")" --if no-reply --in 1m --json
$CLI reminders list --status pending --json
FUTURE="$(node -e "console.log(new Date(Date.now()+70000).toISOString())")"
$CLI reminders run --now "$FUTURE" --json
$CLI reminders run --now "$FUTURE" --json   # {"fired":0,...} second time

echo "== smoke complete =="
