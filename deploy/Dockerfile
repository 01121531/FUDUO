FROM node:24.15.0-bookworm-slim AS builder

ARG FUDUO_VERSION=0.1.0
ENV FUDUO_VERSION=$FUDUO_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM builder AS api
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV HOME=/tmp/home
USER node
CMD ["pnpm", "--filter", "@fuduo/api", "start"]

FROM builder AS worker
ENV HOME=/tmp/home
USER node
CMD ["pnpm", "--filter", "@fuduo/worker", "start"]

FROM builder AS web
ENV HOME=/tmp/home
USER node
CMD ["pnpm", "--filter", "@fuduo/web", "start"]

FROM builder AS openclaw
RUN chmod +x /app/deploy/openclaw-entrypoint.sh \
  && mkdir -p /home/node/.openclaw \
  && chown -R node:node /home/node/.openclaw
ENV HOME=/home/node
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
ENV XDG_CACHE_HOME=/tmp/cache
ENV npm_config_cache=/tmp/npm-cache
USER node
ENTRYPOINT ["/app/deploy/openclaw-entrypoint.sh"]

FROM builder AS openclaw-admin
RUN mkdir -p /home/node/.openclaw \
  && chown -R node:node /home/node/.openclaw
ENV HOME=/home/node
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw
USER node
CMD ["pnpm", "--filter", "@fuduo/openclaw-admin", "start"]

FROM node:24.15.0-bookworm-slim AS openclaw-state-backup
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl tar \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 deploy/openclaw-state-backup.sh /usr/local/bin/openclaw-state-backup
RUN mkdir -p /backups \
  && chown node:node /backups
USER node
ENTRYPOINT ["/usr/local/bin/openclaw-state-backup"]

FROM node:24.15.0-bookworm-slim AS openclaw-state-restore
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl tar \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 deploy/openclaw-state-restore.sh /usr/local/bin/openclaw-state-restore
RUN mkdir -p /backups /restore \
  && chown node:node /restore
USER node
ENTRYPOINT ["/usr/local/bin/openclaw-state-restore"]

FROM postgres:17-bookworm AS backup
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 deploy/postgres-backup.sh /usr/local/bin/postgres-backup
RUN mkdir -p /backups && chown postgres:postgres /backups
USER postgres
ENTRYPOINT ["/usr/local/bin/postgres-backup"]

FROM postgres:17-bookworm AS postgres-restore
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 deploy/postgres-restore.sh /usr/local/bin/postgres-restore
USER postgres
ENTRYPOINT ["/usr/local/bin/postgres-restore"]
