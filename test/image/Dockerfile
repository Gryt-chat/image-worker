# The built worker image plus fixtures and a probe: docker build --build-arg IMAGE=<tag> test/image
ARG IMAGE=gryt-ff-worker

FROM debian:trixie-slim AS fixtures
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY make-fixtures.sh /make-fixtures.sh
RUN sh /make-fixtures.sh /fixtures

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS probe
RUN apk add --no-cache build-base linux-headers
COPY probe.c /probe.c
RUN gcc -O2 -Wall -static-pie -o /probe /probe.c

FROM ${IMAGE}
COPY --from=fixtures /fixtures /fixtures
COPY --from=probe /probe /opt/gryt-ff/probe
COPY entrypoint.sh matrix.js /test/
ENV S3_SECRET_ACCESS_KEY=gryt-ff-canary-secret \
    STORAGE_BACKEND=filesystem \
    DATA_DIR=/data
ENTRYPOINT ["/test/entrypoint.sh"]
CMD ["node", "/test/matrix.js"]
