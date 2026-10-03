# Scanner deployment example

Draft configuration for an AMD64 filesystem worker. The official 1.4 image has
no ARM64 manifest; do not use emulation as the production ARM64 solution.
An ARM64 scanner build remains required. Do not deploy this until the
worker release is reviewed. Stop the previous worker before starting a second
worker against the same database; this example does not replace your server.

Set `GRYT_IMAGE_WORKER_IMAGE` to the reviewed worker image digest,
`GRYT_MEDIA_VOLUME` to its existing named data volume, and `GRYT_MEDIA_BUCKET`
to the existing bucket directory. This example refuses to create a replacement
data volume. S3 deployments need the worker's existing S3 settings instead.

Set `GRYT_CLAMAV_IMAGE` to a reviewed digest of the supported official ClamAV
image. The default pins the tested `1.4_base` digest. Review new image digests
for scanner and operating-system security updates. Consult the
[official Docker guide](https://docs.clamav.net/manual/Installing/Docker.html)
when updating the scanner.

Validate configuration with `docker compose -f examples/scanner/compose.yml config`.
The scanner exposes no TCP port and receives bytes through a private Unix
socket. Its socket volume is read-only in the worker. The scanner has no media
volume, database, S3 credentials or Docker socket. FreshClam updates the separate
signature volume hourly and requires outbound network access. Allocate 4 GiB
for ClamAV, in addition to the worker's memory budget.

`CLAMD_REQUIRED=1` prevents new quarantined media from bypassing a missing scanner.
Configured scanner failures reject jobs without creating malware detection
events. Worker health returns HTTP 503 while a configured or required scanner cannot answer
PING. A successful PING proves availability, not signature freshness or complete
malware coverage. Monitor FreshClam failures; freshness enforcement remains
unfinished. Existing files remain readable.

The limits cover the worker's 64 MiB input ceiling. Limit-exceeded alerts prevent
partial scans from being accepted as clean. Never remove the signature or media
volume when stopping containers. Configuration and engine tests cover this example;
the official-signature deployment still needs an end-to-end rollout test.
`WORKER_IMAGE=<built-worker-image> node test/scanner/deployment.mjs` verifies
the official scanner image with a private EICAR signature and a non-root worker.
