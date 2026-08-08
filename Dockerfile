FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build

FROM --platform=$TARGETPLATFORM node:22-bookworm AS deps
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --production --ignore-engines --network-timeout 600000

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim

RUN groupadd -g 1001 gryt && useradd -m -u 1001 -g 1001 -d /app -s /usr/sbin/nologin gryt
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/package.json ./package.json
COPY --from=builder --chown=gryt:gryt /app/dist ./dist

RUN mkdir -p /data && chown -R gryt:gryt /data

# The tag is the source of truth for a release, and package.json is never
# bumped (see release.yml), so the version has to be handed in at build time.
# Without it the worker reports whatever stale number package.json still holds.
ARG IMAGE_WORKER_VERSION=""
ENV IMAGE_WORKER_VERSION=$IMAGE_WORKER_VERSION

USER gryt
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]