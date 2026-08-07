import consola from "consola";
import http from "http";
import sharp from "sharp";

import {
  getImageJob,
  getUploadMaxBytes,
  initDb,
  listAvatarThumbnails,
  listFilesMissingDominantColor,
  listQueuedImageJobIds,
  updateFileRecord,
  updateImageJobStatus,
} from "./db";
import { findDominantColor, processUploadedImage } from "./processImage";
import { getObjectAsBuffer, initStorage, putObject } from "./storage";

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

const concurrency = clampInt(process.env.IMAGE_WORKER_CONCURRENCY, 2, 1, 8);
const pollMs = clampInt(process.env.IMAGE_WORKER_POLL_MS, 1000, 250, 10_000);
const healthPort = clampInt(process.env.HEALTH_PORT, 8080, 1, 65535);
const backfillMs = clampInt(process.env.IMAGE_WORKER_BACKFILL_MS, 60_000, 5_000, 3_600_000);
const backfillBatch = clampInt(process.env.IMAGE_WORKER_BACKFILL_BATCH, 20, 1, 200);

let inFlight = 0;
let processedCount = 0;
let errorCount = 0;
let colouredCount = 0;
let rethumbedCount = 0;

/**
 * The avatar thumbnail size the server now writes.
 *
 * Kept in step with AVATAR_THUMB_PX in the server's upload route by hand. There
 * is no shared package between these two repositories, and a constant that
 * disagrees only makes this pass regenerate thumbnails forever or never — so if
 * one moves, move the other.
 */
const AVATAR_THUMB_PX = 128;

/**
 * Files this process has already failed to colour.
 *
 * The backfill query selects on `dominant_color IS NULL`, so a file whose
 * object is missing from storage matches forever and would be re-fetched every
 * sweep. Remembering the failures keeps that to once per file per process; a
 * restart retries, which is the right amount of persistence for something that
 * is usually a transient storage problem.
 */
const unreadable = new Set<string>();

async function runOne(jobId: string): Promise<void> {
  const bucket = process.env.S3_BUCKET || "";
  try {
    const job = getImageJob(jobId);
    if (!job || job.status !== "queued") return;

    updateImageJobStatus({ job_id: jobId, status: "processing" });

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
    } = {};
    if (result.compressed && result.newKey && result.newMime && result.newSize !== null) {
      updates.s3_key = result.newKey;
      updates.mime = result.newMime;
      updates.size = result.newSize;
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

/**
 * Give a colour to images that have one missing.
 *
 * The job queue covers whatever is posted to /api/uploads — chat attachments
 * and webhook avatars. A user's own avatar is not: it has a separate route
 * that resizes it inline and queues nothing. Everything uploaded before
 * `dominant_color` existed has a null regardless of how it arrived. So without
 * this pass, a server owner would have to ask every member to re-upload their
 * avatar before the tint that reads this column did anything.
 *
 * Deliberately the lowest-priority thing here: it yields the whole sweep to
 * real jobs, writes only the colour, and never touches the stored object or
 * the thumbnail. Re-deriving those is the job path's business, and doing it
 * from here would replace artefacts the server made on purpose.
 */
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

/**
 * Bring old avatar thumbnails up to the size the client actually needs.
 *
 * They were written at 64px, which is smaller than most places that want one
 * render at on a 2x screen — so the thumbnail existed but was too soft to use,
 * and every avatar in the client fetched the full file instead. The server
 * writes 128 now; this is the same upgrade for everything already uploaded, so
 * nobody has to be asked to re-upload their avatar.
 *
 * Runs once per process. There is no column recording a thumbnail's size, so
 * deciding means decoding it — a couple of kilobytes each, and the seen set
 * keeps it to one pass.
 */
async function upgradeAvatarThumbnails(): Promise<void> {
  const bucket = process.env.S3_BUCKET || "";

  let avatars: Array<{
    file_id: string;
    s3_key: string;
    thumbnail_key: string;
    mime: string | null;
  }>;
  try {
    avatars = listAvatarThumbnails(500);
  } catch {
    return;
  }

  for (const avatar of avatars) {
    if (unreadable.has(avatar.file_id)) continue;

    try {
      const existing = await getObjectAsBuffer(bucket, avatar.thumbnail_key);
      const meta = await sharp(existing, { failOn: "error" }).metadata();
      if ((meta.width ?? 0) >= AVATAR_THUMB_PX) continue;

      // From the stored avatar, not by upscaling the small thumbnail — that
      // would produce something the right number of pixels and no sharper.
      const source = await getObjectAsBuffer(bucket, avatar.s3_key);
      const animated = avatar.mime === "image/gif" || avatar.mime === "image/webp";
      const thumb = await sharp(source, {
        failOn: "error",
        ...(animated ? { pages: 1 } : {}),
      })
        .resize({ width: AVATAR_THUMB_PX, height: AVATAR_THUMB_PX, fit: "cover" })
        .avif({ quality: 50 })
        .toBuffer();

      await putObject(bucket, avatar.thumbnail_key, thumb, "image/avif");
      rethumbedCount++;
      consola.info(
        `[ImageWorker] Rebuilt avatar thumbnail for ${avatar.file_id} at ${AVATAR_THUMB_PX}px (was ${meta.width ?? "?"}px)`,
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
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        processed: processedCount,
        coloured: colouredCount,
        rethumbed: rethumbedCount,
        errors: errorCount,
        inFlight,
      }),
    );
  });
  server.listen(healthPort, () => {
    consola.info(`[ImageWorker] Health server on :${healthPort}`);
  });
}

async function main(): Promise<void> {
  consola.info("[ImageWorker] Starting...");
  consola.info(`[ImageWorker] concurrency=${concurrency}, pollMs=${pollMs}`);

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
