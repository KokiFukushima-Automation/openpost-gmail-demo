# openpost - self-hostable Gmail open-tracking tool.
# Multi-stage, Debian both stages: better-sqlite3's prebuilt binaries are glibc, and building it on
# Alpine means shipping a toolchain or a musl build - not worth it for the size difference.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DB_PATH=/data/openpost.db OUT_DIR=/data/out \
    BIND_ADDRESS=0.0.0.0 PORT=8787 OPENPOST_CONFIG_DIR=/data/config RANGES_DIR=/app/ranges
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data/ranges ./ranges
RUN useradd -r -u 10001 -d /data openpost && mkdir -p /data && chown -R openpost /data
USER openpost
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
