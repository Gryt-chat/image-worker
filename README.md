<div align="center">
  <img src="https://raw.githubusercontent.com/Gryt-chat/client/main/public/logo.svg" width="80" alt="Gryt logo" />
  <h1>Gryt Image Worker</h1>
  <p>Background image processing worker for the <a href="https://github.com/Gryt-chat/gryt">Gryt</a> voice &amp; video platform.<br />Compresses uploads to AVIF, generates thumbnails and updates the shared SQLite database, using <a href="https://sharp.pixelplumbing.com/">Sharp</a>.</p>
</div>

<br />

## Docker

```bash
docker pull ghcr.io/gryt-chat/image-worker:latest
docker run -v gryt-data:/data --env-file .env ghcr.io/gryt-chat/image-worker:latest
```

Browse tags at [ghcr.io/gryt-chat/image-worker](https://github.com/Gryt-chat/image-worker/pkgs/container/image-worker).

## It parses files strangers uploaded

Compressing an avatar sounds like a utility job. This is the process that hands
attacker-controlled bytes to an image decoder, so it's a review-required path
in [the AI policy](https://docs.gryt.chat/docs/guide/ai) and changes here get
read line by line.

## Automatic media reconstruction

New quarantined raster uploads are always decoded and reconstructed as WebP,
including every supported animation frame. The output replaces the uploaded
file even when it takes more storage. Banners use a 960×384 crop. Unsupported
formats, oversized results and processing failures remain unreadable. No person
has to approve an image.

The Docker raster decoder runs as a separate user in a read-only chroot with
runtime libraries. It has no database, storage mount, credentials or network.
The jail also handles colour backfills, avatar thumbnail upgrades and video
poster reconstruction. A decode has a 30-second deadline and a 256 MiB JavaScript
heap limit. Native memory is also subject to the container's memory limit; the
16 GiB address-space ceiling allows Node's virtual-memory reservations.

Production workers refuse raster processing when the jail is unavailable.
Development builds can decode directly for tests. Desktop raster isolation
must be provided before this change can ship in the desktop server.

Existing files remain readable. Legacy image jobs keep their original unless
compression is needed and saves storage. Videos still retain their original:
poster extraction does not reconstruct a complete video. Avatars, emojis and
server pictures uploaded through the server's own processing paths still need
to move to the worker.

## Malware detections

Set `CLAMD_SOCKET` to a private ClamAV Unix socket to scan quarantined media
before decoding. The worker streams bytes using `INSTREAM`; the scanner needs
no access to the storage volume or database. Run it separately with maintained
signatures. Set `StreamMaxLength` and scan limits to cover the 64 MiB processing
ceiling, and enable limit-exceeded alerts so skipped scans cannot report clean.

With a socket configured, scanner errors, disconnects and timeouts reject the
job. A detection creates one `media.scan_detection` event in the existing
permission-protected server audit log, recording the uploader, SHA-256 hash,
scanner and signature. Retrying the same file does not duplicate the event.
Detections do not ban users. Corrupt files and scanner failures create no
malware event.

Without `CLAMD_SOCKET`, malware scanning is disabled and the worker logs a
warning. Its health response distinguishes configured scanning from disabled
scanning; it does not assert scanner readiness. Reconstruction and scanning
reduce risk but cannot guarantee a file is malware-free. Encrypted attachments
remain opaque and cannot be scanned by the server.

## Video posters

A video's poster is one frame that ffmpeg grabs and sharp turns into a JPEG.
The worker opens the file and hands ffmpeg the open descriptor, so ffmpeg never
opens a path itself. It may only use the mov/mp4 and matroska/webm demuxers and
the h264, hevc, vp8, vp9 and AV1 (libdav1d) decoders. It runs on one thread
with a 1 GiB address-space cap, and it's killed after 15 seconds. The flags are
in `src/videoPoster.ts`.

The Docker image builds its own static ffmpeg with nothing else in it: those
two demuxers, those decoders, the PNG encoder, and the `fd` and `pipe`
protocols. The versions and hashes are at the top of the `Dockerfile`, and a
new ffmpeg release means bumping them by hand.

In the image, ffmpeg doesn't run as the worker. The container starts as root
just long enough for `jail/entrypoint.sh` to start `ffjail`, and then the
worker runs as `gryt`. ffjail runs each decode as a second user, `gryt-ff`,
inside an empty chroot. There's no `/proc`, `/data` or `/app` in there to read.
ffmpeg gets an empty environment, no capabilities, the 1 GiB cap, and a
seccomp filter that refuses sockets, ptrace and new processes. All it has is
the input as fd 3 and a pipe for the PNG. `test/image` checks that on every
pull request, with a probe that tries to read the worker's environment and
storage from inside the jail.

If you start the container as a non-root user, the jail can't start, and
videos don't get a poster. The image never runs ffmpeg outside the jail.

Without ffmpeg, on a dev machine or your own build, videos just don't get a
poster. A system ffmpeg has to be 6.0 or newer, for the `fd` protocol. On Linux
the worker also needs `prlimit` from util-linux, and it skips posters rather
than run ffmpeg without the cap.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Path to the shared data directory (contains `gryt.db`) |
| `S3_BUCKET` | — | S3 bucket name (or subdirectory name for filesystem storage) |
| `STORAGE_BACKEND` | `s3` | Storage backend: `s3` or `filesystem` |
| `S3_ENDPOINT` | — | S3-compatible endpoint (e.g. MinIO) |
| `S3_REGION` | `auto` | S3 region |
| `S3_ACCESS_KEY_ID` | — | S3 access key |
| `S3_SECRET_ACCESS_KEY` | — | S3 secret key |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style S3 URLs (required for MinIO) |
| `IMAGE_WORKER_CONCURRENCY` | `2` | Max concurrent image processing jobs (1–8) |
| `IMAGE_WORKER_POLL_MS` | `1000` | Database polling interval in milliseconds (250–10000) |
| `HEALTH_PORT` | `8080` | HTTP health check port |
| `HEALTH_HOST` | `127.0.0.1` | Address the health server binds to. Empty listens on every interface; the Docker image sets `0.0.0.0` |

## Quick start (development)

```bash
yarn install
yarn dev
```

## Build

```bash
yarn build
yarn start
```

## Documentation

Full docs at **[docs.gryt.chat/docs/deployment](https://docs.gryt.chat/docs/deployment)**.

## Issues

Please report bugs and request features in the [main Gryt repository](https://github.com/Gryt-chat/gryt/issues).

## Sponsors

What sponsoring pays for, the tiers, and everyone who has sponsored:
[gryt.chat/sponsors](https://gryt.chat/sponsors). To sponsor:
[GitHub Sponsors](https://github.com/sponsors/Gryt-chat).

The list itself lives in the [Gryt README](https://github.com/Gryt-chat/gryt#sponsors),
in one place rather than ten, so it cannot fall out of step across repositories.

## License

[AGPL-3.0](https://github.com/Gryt-chat/gryt/blob/main/LICENSE) — Part of [Gryt](https://github.com/Gryt-chat/gryt)
