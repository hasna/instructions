# syntax=docker/dockerfile:1
# @hasna/instructions self_hosted service — ARM64 / Bun.
# Default CMD runs instructions-serve (cloud / PURE REMOTE per Amendment A1: the
# serve process reads/writes RDS Postgres directly with @hasna/contracts API-key
# auth). The ECS one-shot migration task overrides the command with `... migrate`.

FROM --platform=linux/arm64 oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY dashboard/package.json ./dashboard/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM --platform=linux/arm64 oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
RUN bun run build:server

FROM --platform=linux/arm64 oven/bun:1 AS runner
WORKDIR /app
# Amazon RDS global CA bundle so TLS to the shared RDS succeeds under
# verify-full-capable clients.
COPY docker/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_ENV=production \
    HASNA_INSTRUCTIONS_STORAGE_MODE=cloud \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    PGSSLROOTCERT=/etc/ssl/certs/rds-global-bundle.pem \
    INSTRUCTIONS_NO_OPEN=true \
    HOST=0.0.0.0 \
    PORT=8080
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
# Fail-closed: instructions-serve /v1 refuses to serve without a cloud DSN +
# signing secret (503), and /ready reports DB reachability — no silent stub.
CMD ["bun", "dist/server/index.js"]
