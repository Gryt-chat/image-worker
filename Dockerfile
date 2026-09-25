FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build

# ffmpeg and dav1d are pinned by hash. Bumping one means checking the release's
# signature first: the FFmpeg release key and the VideoLAN release key.
FROM --platform=$TARGETPLATFORM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS ffmpeg
RUN apk add --no-cache build-base linux-headers meson nasm pkgconf zlib-dev zlib-static
WORKDIR /build

ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG DAV1D_VERSION=1.5.4
ARG DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5

RUN wget -q "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && wget -q "https://download.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz" \
 && printf '%s  %s\n' \
      "$FFMPEG_SHA256" "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
      "$DAV1D_SHA256" "dav1d-${DAV1D_VERSION}.tar.xz" | sha256sum -c - \
 && tar xf "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && tar xf "dav1d-${DAV1D_VERSION}.tar.xz"

RUN cd "dav1d-${DAV1D_VERSION}" \
 && meson setup build --buildtype=release --default-library=static --prefix=/opt/dav1d --libdir=lib \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false \
 && ninja -C build install

# Everything off, then the two demuxers, five decoders, PNG out and the fd and pipe protocols.
RUN cd "ffmpeg-${FFMPEG_VERSION}" \
 && PKG_CONFIG_PATH=/opt/dav1d/lib/pkgconfig ./configure \
      --enable-pic --pkg-config-flags=--static --extra-ldexeflags=-static-pie \
      --extra-cflags="-fstack-protector-strong -D_FORTIFY_SOURCE=2" --extra-ldflags="-Wl,-z,relro,-z,now" \
      --disable-everything --disable-autodetect --disable-network \
      --disable-doc --disable-debug --disable-ffprobe --disable-ffplay \
      --disable-avdevice --disable-swresample \
      --enable-zlib --enable-libdav1d \
      --enable-protocol=fd,pipe \
      --enable-demuxer=mov,matroska \
      --enable-decoder=h264,hevc,vp8,vp9,libdav1d \
      --enable-parser=h264,hevc,vp8,vp9,av1 \
      --enable-encoder=png --enable-muxer=image2pipe --enable-filter=scale \
 && make -j"$(nproc)" ffmpeg \
 && mkdir /out && strip -o /out/ffmpeg ffmpeg

FROM --platform=$TARGETPLATFORM node:22-bookworm AS deps
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --production --ignore-engines --network-timeout 600000

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim

# A static ffmpeg with only what a poster needs, run under prlimit (util-linux, in the base).
COPY --from=ffmpeg /out/ffmpeg /usr/local/bin/ffmpeg

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

# Compose publishes this port, and the community stack dials image-worker:8080
# from another container, so in an image it has to stay on every interface.
ENV HEALTH_HOST=0.0.0.0

USER gryt
EXPOSE 8080

# 127.0.0.1, not localhost: the bind is IPv4 now, and localhost can resolve to ::1.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]