# Single image for the whole pnpm workspace. Each compose service runs a
# different command against it:
#   - migrate           -> tsx (TS source + workspace deps)
#   - api / mcp / embedding -> node on their tsup bundle (dist/server.mjs)
#   - web               -> node on the Nuxt/Nitro build output (.output)
# Debian (glibc), not alpine (musl): onnxruntime-node — the embedding runtime for
# semantic search (CO-241) — ships glibc-only prebuilt bindings and won't load on
# musl. Slim keeps the image lean while staying glibc.
FROM node:24-slim AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
# Fetch deps into the pnpm store from the lockfile alone, in its own layer: the
# expensive download is cached and reused across rebuilds until the lockfile
# changes — source edits no longer re-download anything.
COPY pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

# Browser-facing API URL is baked into the SPA at build time (ssr: false), so it
# must be set here, not at runtime. Default works for a browser on the host.
ARG NUXT_PUBLIC_API_URL=http://127.0.0.1:4400
ENV NUXT_PUBLIC_API_URL=$NUXT_PUBLIC_API_URL

RUN pnpm --filter @agents-board/api build \
  && pnpm --filter @agents-board/mcp build \
  && pnpm --filter @agents-board/embedding-service build \
  && pnpm --filter @agents-board/web build
