import consola from "consola";
import http from "http";
import { createHash } from "node:crypto";

import {
  getImageJob,
  getUploadMaxBytes,
  initDb,
  getAvatarThumbPx,
  listUndersizedAvatarThumbnails,
  listFilesMissingDominantColor,
  listQueuedImageJobIds,
  updateFileRecord,
  updateImageJobStatus,
  recordMediaDetection,
} from "./db";
import { MalwareDetected, probeScanner, scanMedia } from "./malwareScan";
import { checkMediaSize } from "./reconstructImage";
import { reconstructUploadedImage } from "./imageDecoder";
import { findDominantColor, processUploadedImage } from "./processImage";
import { deleteObject, getObjectAsBuffer, initStorage, putObject } from "./storage";
import { findFrameTools, processUploadedVideo } from "./videoPoster";

function clampInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/* The health payload carries the version and the counters, so it defaults to
   loopback. Empty means every interface, as SFU_CONTROL_HOST does. */
function readHost(value: string | undefined): string | undefined {
  const host = value?.trim();
  if (host === undefined) return "127.0.0.1";
  return host === "" ? undefined : host;
}

const concurrency = clampInt(process.env.IMAGE_WORKER_CONCURRENCY, 2, 1, 8);
const pollMs = clampInt(process.env.IMAGE_WORKER_POLL_MS, 1000, 250, 10_000);
const healthPort = clampInt(process.env.HEALTH_PORT, 8080, 1, 65535);
const healthHost = readHost(process.env.HEALTH_HOST);
const backfillMs = clampInt(process.env.IMAGE_WORKER_BACKFILL_MS, 60_000, 5_000, 3_600_000);
const backfillBatch = clampInt(process.env.IMAGE_WORKER_BACKFILL_BATCH, 20, 1, 200);
const scannerRequired = process.env.CLAMD_REQUIRED === "1";

/* IMAGE_WORKER_VERSION first: release.yml versions from `git tag` and never
   bumps package.json, so the file reports a stale version rather than none. */
function readVersion(): string {
  const stamped = process.env.IMAGE_WORKER_VERSION?.trim();
  if (stamped) return stamped.replace(/^v/, "");

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const version = readVersion();

let inFlight = 0;
let processedCount = 0;
let errorCount = 0;
let colouredCount = 0;
let rethumbedCount = 0;

const frameTools = findFrameTools();

/* The backfill selects on `dominant_color IS NULL`, so a file whose object is
   gone matches forever. Without this it is re-fetched every sweep. */
const unreadable = new Set<string>();

async function runOne(jobId: string): Promise<void> {
  const bucket = process.env.S3_BUCKET || "";
  try {
    const job = getImageJob(jobId);
    if (!job || job.status !== "queued") return;

    updateImageJobStatus({ job_id: jobId, status: "processing" });
    if (job.raw_s3_key.startsWith("quarantine/")) checkMediaSize(job.raw_bytes, getUploadMaxBytes());

    if (job.raw_s3_key.startsWith("quarantine/") && scannerRequired && !process.env.CLAMD_SOCKET) throw new Error("Required malware scanner is not configured");
    if (job.raw_s3_key.startsWith("quarantine/") && process.env.CLAMD_SOCKET) {
      const bytes = await getObjectAsBuffer(bucket, job.raw_s3_key);
      checkMediaSize(bytes.length, getUploadMaxBytes());
      try {
        await scanMedia(bytes, process.env.CLAMD_SOCKET);
      } catch (error) {
        if (error instanceof MalwareDetected) recordMediaDetection(job.file_id, createHash("sha256").update(bytes).digest("hex"), error.signature);
        throw error;
      }
    }

    if (job.raw_content_type.toLowerCase().startsWith("video/")) {
      await runPosterJob(jobId, job.file_id, job.raw_s3_key, bucket);
      return;
    }

    const maxBytes = getUploadMaxBytes();

    const result = await processUploadedImage(
      bucket,
      job.file_id,
      job.raw_s3_key,
      job.raw_content_type,
      job.raw_bytes,
      maxBytes,
    );

    const updates: {
      s3_key?: string;
      mime?: string;
      size?: number;
      thumbnail_key?: string | null;
      dominant_color?: string | null;
      width?: number;
      height?: number;
    } = {};
    if (result.compressed && result.newKey && result.newMime && result.newSize !== null) {
      updates.s3_key = result.newKey;
      updates.mime = result.newMime;
      updates.size = result.newSize;
      if (result.width) updates.width = result.width;
      if (result.height) updates.height = result.height;
    }
    if (result.thumbKey) {
      updates.thumbnail_key = result.thumbKey;
    }
    if (result.dominantColor) {
      updates.dominant_color = result.dominantColor;
    }

    if (Object.keys(updates).length > 0) {
      updateFileRecord(job.file_id, updates);
    }

    updateImageJobStatus({ job_id: jobId, status: "done" });
    if (result.newKey && result.newKey !== job.raw_s3_key) {
      await deleteObject(bucket, job.raw_s3_key).catch((error) => consola.warn("Media raw cleanup failed", error));
    }
    processedCount++;
    consola.info(
      `[ImageWorker] Job ${jobId} done (file=${job.file_id}, compressed=${result.compressed}, thumb=${!!result.thumbKey})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    consola.error(`[ImageWorker] Job ${jobId} failed:`, msg);
    errorCount++;
    try {
      updateImageJobStatus({ job_id: jobId, status: "error", error_message: msg });
    } catch (e) {
      consola.warn("Failed to update job status", e);
    }
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/* A refused file is an error on the job, not a crash. A worker without ffmpeg
   finishes the job with no poster, which is what a video had before. */
async function runPosterJob(jobId: string, fileId: string, rawKey: string, bucket: string): Promise<void> {
  const poster = await processUploadedVideo(bucket, fileId, rawKey, frameTools);
  if (rawKey.startsWith("quarantine/") && !poster.thumbKey) {
    throw new Error(poster.reason || "Uploaded video could not be decoded");
  }
  if (poster.thumbKey) updateFileRecord(fileId, { thumbnail_key: poster.thumbKey });

  if (poster.refused) {
    errorCount++;
    consola.warn(`[ImageWorker] Job ${jobId} refused (file=${fileId}): ${poster.reason}`);
    updateImageJobStatus({ job_id: jobId, status: "error", error_message: poster.reason });
    return;
  }

  updateImageJobStatus({ job_id: jobId, status: "done", error_message: poster.reason });
  processedCount++;
  consola.info(
    `[ImageWorker] Job ${jobId} done (file=${fileId}, poster=${poster.thumbKey ? "yes" : `no, ${poster.reason}`})`,
  );
}

function tick(): void {
  if (inFlight >= concurrency) return;
  const capacity = concurrency - inFlight;
  let queued: Array<{ job_id: string }>;
  try {
    queued = listQueuedImageJobIds(capacity);
  } catch {
    return;
  }
  if (queued.length === 0) return;
  for (const { job_id } of queued) {
    if (inFlight >= concurrency) break;
    inFlight++;
    runOne(job_id)
      .catch((e) => consola.warn("tick error", e))
      .finally(() => {
        inFlight--;
      });
  }
}

/* Writes only the colour. Re-deriving the stored object or the thumbnail is
   the job path's business, and doing it here would replace what it made. */
async function backfillColours(): Promise<void> {
  if (inFlight >= concurrency) return;

  let pending: Array<{ file_id: string; s3_key: string; mime: string | null }>;
  try {
    pending = listFilesMissingDominantColor(backfillBatch);
  } catch {
    return;
  }

  const bucket = process.env.S3_BUCKET || "";

  for (const file of pending) {
    if (unreadable.has(file.file_id)) continue;
    if (inFlight >= concurrency) return;

    try {
      const buffer = await getObjectAsBuffer(bucket, file.s3_key);
      const animated = file.mime === "image/gif" || file.mime === "image/webp";
      const colour = await findDominantColor(buffer, animated);

      if (!colour) {
        unreadable.add(file.file_id);
        continue;
      }

      updateFileRecord(file.file_id, { dominant_color: colour });
      colouredCount++;
      consola.info(`[ImageWorker] Backfilled colour ${colour} for file ${file.file_id}`);
    } catch (err) {
      unreadable.add(file.file_id);
      consola.warn(
        `[ImageWorker] Could not colour ${file.file_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/* The target size comes from the server, not a constant here. Anything else
   lets the two repositories disagree without either noticing. */
async function upgradeAvatarThumbnails(): Promise<void> {
  const bucket = process.env.S3_BUCKET || "";

  const targetPx = getAvatarThumbPx();
  if (!targetPx) {
    consola.info(
      "[ImageWorker] Server publishes no avatar thumbnail size — skipping thumbnail upgrade",
    );
    return;
  }

  let avatars: Array<{
    file_id: string;
    s3_key: string;
    thumbnail_key: string;
    mime: string | null;
  }>;
  try {
    avatars = listUndersizedAvatarThumbnails(targetPx, 500);
  } catch {
    return;
  }

  for (const avatar of avatars) {
    if (unreadable.has(avatar.file_id)) continue;

    try {
      // From the stored avatar, not by upscaling the old thumbnail — that would
      // produce the right number of pixels and no more detail.
      const source = await getObjectAsBuffer(bucket, avatar.s3_key);
      const { thumb } = await reconstructUploadedImage(source, 0, false, targetPx, "avatar-thumb");

      await putObject(bucket, avatar.thumbnail_key, thumb, "image/avif");
      updateFileRecord(avatar.file_id, { thumbnail_px: targetPx });
      rethumbedCount++;
      consola.info(
        `[ImageWorker] Rebuilt avatar thumbnail for ${avatar.file_id} at ${targetPx}px`,
      );
    } catch (err) {
      unreadable.add(avatar.file_id);
      consola.warn(
        `[ImageWorker] Could not rebuild thumbnail for ${avatar.file_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function startHealthServer(): void {
  let readiness: Promise<boolean> | undefined;
  let checkedAt = 0;
  const scannerReady = () => {
    if (!readiness || Date.now() - checkedAt > 5000) {
      checkedAt = Date.now();
      readiness = probeScanner(process.env.CLAMD_SOCKET ?? "");
    }
    return readiness;
  };
  const server = http.createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];

    if (path === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "image-worker", version }));
      return;
    }

    void scannerReady().then((ready) => {
      const healthy = (!scannerRequired && !process.env.CLAMD_SOCKET) || ready;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: healthy ? "ok" : "unavailable",
          version,
          processed: processedCount,
          coloured: colouredCount,
          rethumbed: rethumbedCount,
          errors: errorCount,
          inFlight,
          malwareScanning: process.env.CLAMD_SOCKET ? "configured" : "disabled",
          scannerRequired,
          scannerReady: ready,
          rasterIsolation: process.env.IMAGEJAIL_SOCKET ? "configured" : "unavailable",
        }),
      );
    });
  });
  server.listen(healthPort, healthHost, () => {
    consola.info(
      `[ImageWorker] Health server on ${healthHost ?? "*"}:${healthPort}`,
    );
  });
}

async function main(): Promise<void> {
  consola.info(`[ImageWorker] Starting v${version}...`);
  consola.info(`[ImageWorker] concurrency=${concurrency}, pollMs=${pollMs}`);
  if (!process.env.CLAMD_SOCKET) {
    if (scannerRequired) consola.error("[ImageWorker] Required scanner missing: new media is blocked");
    else consola.warn("[ImageWorker] Malware scanning disabled: CLAMD_SOCKET is not configured");
  }
  consola.info(
    frameTools.jail
      ? `[ImageWorker] Video posters: ffmpeg in the jail at ${frameTools.jail.socket}, ffjail=${frameTools.jail.client ?? "none"}`
      : `[ImageWorker] Video posters: ffmpeg=${frameTools.ffmpeg ?? "none"}, prlimit=${frameTools.prlimit ?? "none"}`,
  );

  await initStorage();
  initDb();

  startHealthServer();

  setInterval(() => {
    try {
      tick();
    } catch (e) {
      consola.warn("poll error", e);
    }
  }, pollMs);

  consola.info("[ImageWorker] Polling started");

  void backfillColours().catch((e) => consola.warn("backfill error", e));
  setInterval(() => {
    void backfillColours().catch((e) => consola.warn("backfill error", e));
  }, backfillMs);

  consola.info(`[ImageWorker] Colour backfill every ${backfillMs}ms`);

  void upgradeAvatarThumbnails().catch((e) =>
    consola.warn("avatar thumbnail upgrade error", e),
  );
}

main().catch((err) => {
  consola.error("[ImageWorker] Fatal:", err);
  process.exit(1);
});
