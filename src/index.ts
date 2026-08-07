import consola from "consola";
import http from "http";

import {
  getImageJob,
  getUploadMaxBytes,
  initDb,
  listFilesMissingDominantColor,
  listQueuedImageJobIds,
  updateFileRecord,
  updateImageJobStatus,
} from "./db";
import { findDominantColor, processUploadedImage } from "./processImage";
import { getObjectAsBuffer, initStorage } from "./storage";

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
 * The job queue only covers chat uploads. Avatars are resized by the server
 * inline and never queued, and everything uploaded before `dominant_color`
 * existed has a null regardless of how it arrived — so without this pass, a
 * server owner would have to ask every member to re-upload their avatar before
 * the tint that reads this column did anything.
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

function startHealthServer(): void {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        processed: processedCount,
        coloured: colouredCount,
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
}

main().catch((err) => {
  consola.error("[ImageWorker] Fatal:", err);
  process.exit(1);
});
