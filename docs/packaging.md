# Packaging

## Docker

`Dockerfile` is a two-stage build (`node:22-bookworm-slim` both stages - better-sqlite3's prebuilt
binaries are glibc, and building it on Alpine means shipping a toolchain or a musl build). The
final image:

- Runs as a non-root `openpost` user (uid 10001), with `/data` as the only writable path.
- Declares `VOLUME ["/data"]` - `DB_PATH`, `OUT_DIR` and `OPENPOST_CONFIG_DIR` all live under it.
- Sets `BIND_ADDRESS=0.0.0.0` (a container's loopback is not reachable from outside it) - this
  means `assertSafeToBind` requires `API_TOKEN` to be set, and the dashboard likewise requires a
  password or bearer. The image refuses to start insecurely; this is intended, not a bug to work
  around with `BIND_ADDRESS=127.0.0.1` (which would make the service unreachable from outside the
  container entirely).
- Ships a `HEALTHCHECK` against `/healthz`.

`compose.yaml` runs one service against a named volume, publishing only to `127.0.0.1:8787` by
default - `openpost tunnel` (or a reverse proxy) is the actual exposure story, not a directly
published container port.

The roadmap's "< 150 MB" target is not asserted in CI (there is no CI in this repository); the
measured size from a real `docker build` is recorded in `docs/reports/phase4_smoke.md` when a
Docker daemon is available. `node:22-bookworm-slim` alone is roughly 220 MB uncompressed, so the
honest expectation is "≈ 250 MB uncompressed / ≈ 90 MB compressed pull" - the roadmap line is
corrected here rather than quietly missed.

## systemd

See `packaging/README.md` for the four install commands, `packaging/openpost.service` for the
hardened unit, and `packaging/openpost.env.example` for the environment file template.

## Node SEA (single binary): deferred, with reasons

The roadmap's "single binary runs on a clean container with no Node installed" is **formally
amended**, not quietly missed:

1. `better-sqlite3` is a native addon. Node's SEA (`node --experimental-sea-config`) embeds one
   JavaScript blob into the `node` binary itself; `process.dlopen` still needs
   `better_sqlite3.node` on disk at a known path. The "single binary" would in practice be a binary
   plus a sidecar `.node` file, which is a worse packaging story than a tarball, not a better one.
2. SEA requires a single pre-bundled JS file - i.e. esbuild or `@vercel/ncc` - which is a bundler
   (explicitly excluded from this codebase's stack) and a new devDependency, plus rewriting
   `migrationsDir()` (src/db/index.ts) and `loadDashboardAssets()` (src/server/assets/index.ts),
   both of which resolve paths from `import.meta.url` and assume a normal `node_modules`/`dist`
   layout on disk.
3. The actual user value - "runs on a clean machine with no Node installed" - is fully delivered by
   the Docker image above, which ships today and can be verified with `docker run`.
4. The clean path exists and is cheap **later**: when this tree moves from `better-sqlite3` to the
   built-in `node:sqlite` (stable in recent Node LTS), the native addon disappears and SEA becomes
   a genuine one-file build with no bundler needed for the addon itself. That migration is a phase
   of its own - different API, different transaction helpers, different test surface - and is out
   of scope here.

**Roadmap line, amended:** *"Docker image runs on a host with no Node installed; SEA single binary
deferred to a future phase, gated on the `node:sqlite` migration."*

If a Node toolchain and network access are available and the exact recipe is wanted once
`node:sqlite` has landed:

```sh
node --experimental-sea-config sea-config.json
node -e "require('fs').copyFileSync(process.execPath, 'openpost-bin')"
npx postject openpost-bin NODE_SEA_BLOB dist/bundle.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

with `dist/bundle.blob` produced by bundling `dist/cli/index.js` (once no native addon needs to be
`dlopen`'d) via esbuild's `--bundle --platform=node` and `node --experimental-sea-config`'s own
blob-generation step. This is recorded here so the next phase does not have to re-derive it.
