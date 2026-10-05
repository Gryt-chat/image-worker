FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --ignore-scripts --ignore-engines

COPY . .
RUN yarn build

# ffmpeg and dav1d are pinned by hash. Bumping one means checking the release's
# signature first: the FFmpeg release key and the VideoLAN release key.
FROM --platform=$TARGETPLATFORM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS ffmpeg
RUN apk add --no-cache build-base linux-headers meson nasm pkgconf zlib-dev zlib-static cmake samurai
WORKDIR /build

ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG DAV1D_VERSION=1.5.4
ARG DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
# The AV1 encoder, for banner and avatar videos (GRYT-1664). GitLab's tag archive, pinned by hash.
ARG SVTAV1_VERSION=4.2.0
ARG SVTAV1_SHA256=c7b13c4a84bd3751aa35fcc72be13e6875467e7c2216879251a486e5b1e4e740

RUN wget -q "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && wget -q -O svtav1.tar.gz "https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/v${SVTAV1_VERSION}/SVT-AV1-v${SVTAV1_VERSION}.tar.gz" \
 && wget -q "https://download.videolan.org/pub/videolan/dav1d/${DAV1D_VERSION}/dav1d-${DAV1D_VERSION}.tar.xz" \
 && printf '%s  %s\n' \
      "$FFMPEG_SHA256" "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
      "$DAV1D_SHA256" "dav1d-${DAV1D_VERSION}.tar.xz" \
      "$SVTAV1_SHA256" "svtav1.tar.gz" | sha256sum -c - \
 && tar xf "ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && tar xf "dav1d-${DAV1D_VERSION}.tar.xz" \
 && tar xf svtav1.tar.gz

RUN cd "dav1d-${DAV1D_VERSION}" \
 && meson setup build --buildtype=release --default-library=static --prefix=/opt/dav1d --libdir=lib \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false \
 && ninja -C build install

RUN cd "SVT-AV1-v${SVTAV1_VERSION}" \
 && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_APPS=OFF \
      -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=/opt/svtav1 -DCMAKE_INSTALL_LIBDIR=lib \
 && cmake --build build && cmake --install build

# Everything off, then the two demuxers, five decoders, PNG and AV1 out, MP4 for the video,
# the filters a transcode needs, and the fd and pipe protocols.
RUN cd "ffmpeg-${FFMPEG_VERSION}" \
 && PKG_CONFIG_PATH=/opt/dav1d/lib/pkgconfig:/opt/svtav1/lib/pkgconfig ./configure \
      --enable-pic --pkg-config-flags=--static --extra-ldexeflags=-static-pie \
      --extra-cflags="-fstack-protector-strong -D_FORTIFY_SOURCE=2" --extra-ldflags="-Wl,-z,relro,-z,now" \
      --disable-everything --disable-autodetect --disable-network \
      --disable-doc --disable-debug --disable-ffprobe --disable-ffplay \
      --disable-avdevice --disable-swresample \
      --enable-zlib --enable-libdav1d --enable-libsvtav1 \
      --enable-protocol=fd,pipe \
      --enable-demuxer=mov,matroska \
      --enable-decoder=h264,hevc,vp8,vp9,libdav1d \
      --enable-parser=h264,hevc,vp8,vp9,av1 \
      --enable-encoder=png,libsvtav1 --enable-muxer=image2pipe,mp4 \
      --enable-filter=scale,fps,crop,setsar,format \
 && make -j"$(nproc)" ffmpeg \
 && mkdir /out && strip -o /out/ffmpeg ffmpeg

FROM --platform=$TARGETPLATFORM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS ffjail
RUN apk add --no-cache build-base linux-headers
COPY jail/ffjail.c /build/ffjail.c
RUN gcc -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -static-pie \
      -o /build/ffjail /build/ffjail.c

FROM --platform=$TARGETPLATFORM node:22-bookworm AS deps
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --production --ignore-engines --network-timeout 600000

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim

# ffmpeg isn't on PATH: it only runs through ffjail, as gryt-ff, in /opt/gryt-ff/jail, which holds
# nothing else. ffjail runs it by its path in there.
COPY --from=ffmpeg /out/ffmpeg /opt/gryt-ff/jail/ffmpeg
COPY --from=ffjail /build/ffjail /usr/local/bin/ffjail
COPY jail/entrypoint.sh /usr/local/bin/gryt-entrypoint

RUN groupadd -g 1001 gryt && useradd -m -u 1001 -g 1001 -d /app -s /usr/sbin/nologin gryt \
 && groupadd -g 1002 gryt-ff && useradd -M -u 1002 -g 1002 -d /nonexistent -s /usr/sbin/nologin gryt-ff \
 && chmod 0555 /opt/gryt-ff/jail /opt/gryt-ff/jail/ffmpeg \
 && install -d -m 0750 -g gryt /run/gryt-ff
ENV FFJAIL_SOCKET=/run/gryt-ff/ffjail.sock
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps --chown=gryt:gryt /app/node_modules ./node_modules
COPY --from=builder --chown=gryt:gryt /app/package.json ./package.json
COPY --from=builder --chown=gryt:gryt /app/dist ./dist

# The image jail: node, sharp and the re-encode code, and nothing else. No /data, no
# credentials, no network; ffjail runs it as gryt-ff in this tree (GRYT-1664).
RUN install -d -m 0755 /opt/gryt-image/jail/usr/local/bin /opt/gryt-image/jail/decoder/dist /opt/gryt-image/jail/decoder/node_modules \
 && cp /usr/local/bin/node /opt/gryt-image/jail/usr/local/bin/node \
 && cp dist/reencodeEntry.js dist/reencode.js dist/reencodeResult.js dist/colour.js /opt/gryt-image/jail/decoder/dist/ \
 && cp -a node_modules/sharp node_modules/detect-libc node_modules/semver node_modules/@img /opt/gryt-image/jail/decoder/node_modules/ \
 && for binary in /usr/local/bin/node /app/node_modules/@img/sharp-linux-*/lib/*.node /app/node_modules/@img/sharp-libvips-linux-*/lib/*.so*; do \
      ldd "$binary" | awk '$3 ~ /^\// {print $3} $1 ~ /^\// {print $1}' | while read -r library; do \
        mkdir -p "/opt/gryt-image/jail$(dirname "$library")"; cp -L "$library" "/opt/gryt-image/jail$library"; \
      done; \
    done
ENV IMAGEJAIL_SOCKET=/run/gryt-ff/imagejail.sock

RUN mkdir -p /data && chown -R gryt:gryt /data

# The tag is the source of truth for a release, and package.json is never
# bumped (see release.yml), so the version has to be handed in at build time.
# Without it the worker reports whatever stale number package.json still holds.
ARG IMAGE_WORKER_VERSION=""
ENV IMAGE_WORKER_VERSION=$IMAGE_WORKER_VERSION

# Compose publishes this port, and the community stack dials image-worker:8080
# from another container, so in an image it has to stay on every interface.
ENV HEALTH_HOST=0.0.0.0

# No USER: the entrypoint starts the jail as root, then runs the worker as gryt.
EXPOSE 8080

# 127.0.0.1, not localhost: the bind is IPv4 now, and localhost can resolve to ::1.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/gryt-entrypoint"]
CMD ["node", "dist/index.js"]