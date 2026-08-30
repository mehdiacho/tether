# Node 24 strips TypeScript natively, so there is no build stage and no dist/.
# What runs in production is the same source you edit.
#
# Pinned to a minor rather than :latest — this image is meant to be published,
# and "whatever Node was current when you pulled" is not a reproducible build.
FROM node:24.20-alpine

LABEL org.opencontainers.image.title="Tether" \
      org.opencontainers.image.description="Human-in-the-loop layer for AI agents: notify, ask, and wait for an answer." \
      org.opencontainers.image.source="https://github.com/mehdiacho/tether" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install deps first so a source edit doesn't invalidate the dependency layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# SQLite and rendered audio live on a mounted volume, not in the image.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DB_PATH=/data/tether.db
ENV PORT=8790
ENV NODE_ENV=production

# uid 1000 in the official Node images, which lines up with the homelab's
# PUID/PGID convention — so a bind-mounted /data needs no chown gymnastics.
USER node
EXPOSE 8790

# src/index.ts installs SIGTERM/SIGINT handlers, so node is safe as PID 1 and
# `docker compose down` is a clean stop rather than a ten-second timeout.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8790/health || exit 1

CMD ["node", "src/index.ts"]
