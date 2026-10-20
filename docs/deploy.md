# Deploying openpost

openpost is a single Node process plus a single SQLite file. It has no external services to stand
up - the only decision is how the tracking pixel becomes reachable from the public internet. This
document is the operator-run half of `docs/05_phase2_spec.md` §3; `openpost tunnel` prints the
commands below verbatim and `openpost doctor` verifies the result.

## The `TRACKING_BASE_URL` / `TRUST_PROXY` contract

| Deployment | `TRACKING_BASE_URL` | `BIND_ADDRESS` | `TRUST_PROXY` | client IP source |
|---|---|---|---|---|
| Local dev / CI | `http://127.0.0.1:8787` | `127.0.0.1` | `false` | socket |
| Cloudflare Tunnel (recommended) | `https://t.example.com` | `127.0.0.1` | `true` | `X-Forwarded-For` from `cloudflared` |
| ngrok (connectivity test only) | `https://<random>.ngrok-free.app` | `127.0.0.1` | `true` | `X-Forwarded-For` |
| Fly.io | `https://<app>.fly.dev` or custom | `0.0.0.0` | `true` | `X-Forwarded-For` from fly-proxy |
| Direct port exposure | `https://t.example.com` | `0.0.0.0` | **`false`** | socket |

Getting `TRUST_PROXY` wrong silently destroys classification: with it off behind a real proxy,
every open shares the proxy's IP hash, breaking self-open detection, fanout/scanner detection and
the Apple/Google range rules alike. `openpost doctor`'s `proxy.contract` check enforces the rule
in `docs/05_phase2_spec.md` §3.1: `TRUST_PROXY=true` is only safe when the process is unreachable
except through the proxy (a loopback bind, or a platform that terminates TLS in front of it).

## Cloudflare Tunnel (recommended)

Stable hostname on your own domain, free, no inbound port to open, a real certificate, and - if
you use a subdomain of your sending domain, as doc 02 §3 recommends for spam safety - the pixel
domain and your From address share a reputation.

```bash
cloudflared tunnel login
cloudflared tunnel create openpost
cloudflared tunnel route dns openpost t.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 openpost

# in the shell that runs `openpost serve`:
export TRACKING_BASE_URL=https://t.example.com
export TRUST_PROXY=true
export BIND_ADDRESS=127.0.0.1
openpost doctor --url https://t.example.com
```

`openpost tunnel --provider cloudflare --hostname t.example.com` prints exactly these lines
(with your hostname substituted) plus the prerequisites and the doctor verify command.

## ngrok (10-minute connectivity test only)

```bash
ngrok http 8787
# copy the https://<random>.ngrok-free.app URL it prints, then:
export TRACKING_BASE_URL=https://<random>.ngrok-free.app
export TRUST_PROXY=true
export BIND_ADDRESS=127.0.0.1
```

`*.ngrok-free.app` is heavily blocklisted by mail providers - use it only to confirm that an
inbound request reaches your pixel, never for a real send. `openpost doctor` warns (not fails) on
this hostname shape so you don't forget.

## Fly.io (always-on self-hosting)

SQLite tolerates exactly **one writer**, so this is a single-machine deployment with autoscaling
off:

```toml
# fly.toml (essentials)
[http_service]
  internal_port = 8787
  force_https = true

[[mounts]]
  source = "openpost_data"
  destination = "/data"
```

```bash
fly launch --no-deploy
fly volumes create openpost_data --size 1
fly secrets set TRACKING_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))") \
                WEBHOOK_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
fly deploy
```

Set in the app's environment (via `fly secrets set` or `[env]` in `fly.toml`):

```
DB_PATH=/data/openpost.db
BIND_ADDRESS=0.0.0.0
TRUST_PROXY=true
TRACKING_BASE_URL=https://<app>.fly.dev   # or a custom domain fronted by Fly
min_machines_running = 1                  # scale config, not an env var - keep it at exactly 1
```

Then `openpost doctor --url https://<app>.fly.dev`.

**Vercel is not supported** for the main instance: it has no persistent SQLite volume. A
stateless-edge-pixel-that-forwards-to-the-home-instance design is deferred to Phase 4.

## Docker

```bash
docker build -t openpost .
docker compose up -d   # reads .env in the current directory; see compose.yaml
curl -s http://127.0.0.1:8787/healthz
```

The image sets `BIND_ADDRESS=0.0.0.0` internally (a container's loopback is not reachable from
outside it), which means `openpost` refuses to start unless `API_TOKEN` is set (the existing
non-loopback-bind rule above) and the dashboard has a password or bearer configured. This is
intentional - see `docs/packaging.md`. `compose.yaml` publishes only to `127.0.0.1:8787` by
default; put a reverse proxy or `openpost tunnel` in front of the container for real exposure, the
same as a bare-metal install. Data (the SQLite file, `OUT_DIR`, the master keyfile) lives under the
`/data` volume, which survives `docker compose down && up`.

Measure the built image size with `docker image ls openpost` and record it in
`docs/reports/phase4_smoke.md` - the roadmap's size target is not asserted in CI, only measured and
reported honestly (see `docs/packaging.md`).

## systemd (bare metal / VM, no container)

```bash
sudo useradd --system --home /var/lib/openpost --create-home openpost
sudo mkdir -p /opt/openpost /etc/openpost
sudo cp -r dist node_modules package.json /opt/openpost/
sudo install -m 600 -o openpost -g openpost packaging/openpost.env.example /etc/openpost/openpost.env
sudo install -m 644 packaging/openpost.service /etc/systemd/system/openpost.service
sudo systemctl daemon-reload && sudo systemctl enable --now openpost
```

Edit `/etc/openpost/openpost.env` first. See `packaging/README.md` for details and
`packaging/openpost.service` for the hardening directives (`ProtectSystem=strict`, `UMask=0077`,
etc.) that confine the process to `/var/lib/openpost` and the network.

## Backups

```bash
openpost backup --out ./backups --gzip                 # or BACKUP_ENABLED=true for a scheduled one
openpost restore ./backups/openpost-....sqlite.gz --to ./restored.db --dry-run   # check first

# Restoring over the LIVE database: stop the server first.
sudo systemctl stop openpost
openpost restore ./backups/openpost-....sqlite.gz --to /var/lib/openpost/openpost.db --force
sudo systemctl start openpost
```

Backups use SQLite's own online backup API (`better-sqlite3`'s `db.backup()`), never a raw `cp` of
a live WAL-mode database file - safe to run while `openpost serve` keeps writing. Restoring is the
opposite: **stop the server (or any other process with the destination open) before you restore
over it.** `restore` refuses by default when `${to}-wal`/`${to}-shm` files exist, or when the
destination cannot be locked exclusively - either is evidence something still has it open, and
restoring anyway silently throws the restored data away the moment that process next checkpoints
its WAL over your restored bytes. `--force` overrides the refusal (any stale `-wal`/`-shm` file is
always deleted alongside the destination once a restore actually proceeds), but does not make it
safe to restore under a live writer - stop the process first. Each backup carries a manifest (row
counts, sha256, schema version, and - if account secrets exist - a master key fingerprint) that
`restore` checks before touching anything. A backup encrypted under one master key restored on a
host with a different key still restores the *rows*; the secrets inside them will not decrypt
until you either restore the matching keyfile too or run `openpost accounts rotate-key`.

## Optional local geo

```bash
# Download a GeoLite2-City.mmdb from your own free MaxMind account - openpost ships no geo data
# and never will (the license forbids redistribution).
export GEOIP_DB_PATH=/var/lib/openpost/GeoLite2-City.mmdb
```

`openpost doctor` warns when the file is older than `GEOIP_MAX_AGE_DAYS` (default 90) and fails
(`geo.db`) if it's set but not actually applied - unreadable, unparseable, or the optional
`mmdb-lib` dependency isn't installed; `doctor` performs the same load `serve` does, not just a
file-existence check. Without `GEOIP_DB_PATH` set at all, tracking works exactly the same and is
fully honest about proxied opens - geo is purely an enrichment on top of the existing
classification, applied only to counted (non-proxied, non-bot) opens/clicks and capped by both
`GEOIP_GRANULARITY` and `PRIVACY_MODE` (whichever is stricter) before anything is stored.

## Mobile: HTTPS is doubly required

From Phase 5 on, a public HTTPS hostname (or loopback, for local testing) is required for two
independent reasons: the tracking pixel itself (unchanged since Phase 1), and now also **service
worker registration and Web Push**, which every browser refuses to allow outside a "secure context"
(`https:` or loopback). If you already have a Cloudflare Tunnel/Fly.io/direct-TLS setup from the
table above, nothing new is required - the same `TRACKING_BASE_URL` covers both. See
docs/mobile.md for the full mobile install, Web Push and add-on story, and consider raising
`DASHBOARD_SESSION_HOURS` (e.g. `720`) if the dashboard is used mostly from an installed PWA, which
has its own cookie jar and otherwise re-prompts for login every `DASHBOARD_SESSION_HOURS` (default
12).

## Operator-only steps not run in CI

The following are documented here and in `docs/05_phase2_spec.md` but are not automated or run by
this repository's test suite (they need a public hostname, a real Google account, or a live
network) - see `docs/reports/phase2_smoke.md` for what was actually run and what was not:

- Any of the three tunnel providers actually establishing a public hostname.
- `openpost auth gmail` completing a real consent screen with a real Google account.
- `openpost update-ranges --source apple` / `--source google` downloading the live CSV/JSON (the
  `--from-file` path is the tested equivalent).
- A real `MAIL_TRANSPORT=smtp SELF_OPEN_STRATEGY=insert` send landing in a real Gmail account's
  Sent folder.
- Phase 5: installing the PWA on a real phone (Add to Home Screen), a real push notification
  reaching a real device, and the Gmail add-on's actual install/compose-card-visibility checklist -
  see `docs/reports/phase5_smoke.md` and `addon/README.md`.
