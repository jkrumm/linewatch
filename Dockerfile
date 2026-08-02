# syntax=docker/dockerfile:1
# Five stages: `base` installs the API's bun deps + copies source,
# `web-build` builds the SPA (owned by web/ — this stage only reads its
# package.json/build script, never writes into that directory), `ookla`
# downloads and extracts the speedtest CLI, `fingerprint` hashes the source
# that went in, `runner` combines them into the final non-root image. Debian, NOT alpine (`oven/bun:1`, not `-alpine`):
# the Ookla CLI's aarch64 build is glibc-linked (docs/DESIGN.md "Dockerfile").
# Built via `make up` / `make rebuild` — never a raw `docker build`
# (docker-makefile rule).

FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --production --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

FROM oven/bun:1 AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM oven/bun:1 AS ookla
WORKDIR /tmp/ookla
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
# Version pinned in the URL itself — verified 200 OK 2026-07-30 (docs/DESIGN.md).
RUN curl -fsSL https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-linux-aarch64.tgz -o speedtest.tgz \
  && tar -xzf speedtest.tgz speedtest \
  && chmod +x speedtest

# Both deployed trees, hashed together. `make up` compares this against the same
# command run on the host and fails if they differ (scripts/codesum.ts).
FROM oven/bun:1 AS fingerprint
WORKDIR /app
COPY scripts ./scripts
COPY src ./src
COPY web/src ./web/src
RUN bun scripts/codesum.ts src web/src > /app/.codesum

FROM oven/bun:1 AS runner
WORKDIR /app

# curl: the HEALTHCHECK below. ca-certificates: TLS for both curl and the
# Ookla CLI's own outbound speed-test connections. sqlite3: the database lives in
# a Docker volume the host cannot open (docs/storage.md), so every `make db-*`
# target reaches it through a container — including `db-restore`, which runs
# while the API is stopped and therefore cannot borrow bun from a live process.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 \
  && groupadd --system app && useradd --system --gid app --home-dir /app app

COPY --from=ookla /tmp/ookla/speedtest /usr/local/bin/speedtest

COPY --from=base --chown=app:app /app/node_modules /app/node_modules
COPY --from=base --chown=app:app /app/src /app/src
COPY --from=base --chown=app:app /app/drizzle /app/drizzle
COPY --from=base --chown=app:app /app/package.json /app/package.json
COPY --from=base --chown=app:app /app/tsconfig.json /app/tsconfig.json
COPY --from=web-build --chown=app:app /app/web/dist /app/web/dist
COPY --from=fingerprint --chown=app:app /app/.codesum /app/.codesum

ENV NODE_ENV=production
EXPOSE 7731

USER app

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:7731/health || exit 1

CMD ["bun", "run", "src/index.ts"]
