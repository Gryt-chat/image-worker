import sharp from "sharp";

import { deleteObject, getObjectAsBuffer, putObject } from "./storage";

export interface ProcessResult {
  compressed: boolean;
  newKey: string | null;
  newMime: string | null;
  newSize: number | null;
  thumbKey: string | null;
  /** #rrggbb, or null if the image has no readable colour. */
  dominantColor: string | null;
}

const MAX_INPUT_PIXELS = 100_000_000;

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * The image's dominant colour, for tinting surfaces that stand in for it —
 * a voice tile behind someone's avatar, for instance.
 *
 * Computed here because this worker is already decoding the image to build a
 * thumbnail, so it costs one extra pass over an already-loaded buffer and
 * happens once per upload rather than once per person looking at it.
 *
 * Never throws: a colour is a nicety, and failing to find one must not fail
 * the upload that carries it.
 */
async function findDominantColor(
  buffer: Buffer,
  animated: boolean,
): Promise<string | null> {
  try {
    const { dominant } = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      ...(animated ? { pages: 1 } : {}),
    }).stats();

    if (!dominant) return null;

    return `#${toHex(dominant.r)}${toHex(dominant.g)}${toHex(dominant.b)}`;
  } catch {
    return null;
  }
}

export async function processUploadedImage(
  bucket: string,
  fileId: string,
  rawKey: string,
  rawContentType: string,
  rawBytes: number,
  maxBytes: number,
): Promise<ProcessResult> {
  const rawBuffer = await getObjectAsBuffer(bucket, rawKey);

  const mimeStr = rawContentType.toLowerCase();
  const isGif = mimeStr === "image/gif";
  const isWebp = mimeStr === "image/webp";
  const isAvif = mimeStr === "image/avif";
  const isPotentiallyAnimated = isGif || isWebp;

  const meta = await sharp(rawBuffer, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    ...(isPotentiallyAnimated ? { animated: true } : {}),
  }).metadata();

  const isAnimated =
    isPotentiallyAnimated &&
    typeof meta.pages === "number" &&
    meta.pages > 1;

  const shouldKeepOriginal = isGif || isAvif || (isWebp && isAnimated);

  let newKey: string | null = null;
  let newMime: string | null = null;
  let newSize: number | null = null;
  const hasLimit = typeof maxBytes === "number" && maxBytes > 0;

  if (!shouldKeepOriginal && hasLimit && rawBytes > maxBytes) {
    const avifBuf = await sharp(rawBuffer, { failOn: "error" }).avif().toBuffer();
    if (avifBuf.length <= maxBytes) {
      newKey = `uploads/${fileId}.avif`;
      newMime = "image/avif";
      newSize = avifBuf.length;
      await putObject(bucket, newKey, avifBuf, "image/avif");

      if (newKey !== rawKey) {
        await deleteObject(bucket, rawKey).catch(() => {});
      }
    }
  }

  const thumbPipeline = isPotentiallyAnimated
    ? sharp(rawBuffer, { pages: 1, failOn: "error" })
    : sharp(rawBuffer, { failOn: "error" });

  let thumbKey: string | null = null;
  const thumb = await thumbPipeline
    .resize({ width: 320, withoutEnlargement: true })
    .avif({ quality: 50 })
    .toBuffer()
    .catch(() => null);

  if (thumb) {
    thumbKey = `thumbnails/${fileId}.avif`;
    await putObject(bucket, thumbKey, thumb, "image/avif");
  }

  const dominantColor = await findDominantColor(rawBuffer, isPotentiallyAnimated);

  return {
    compressed: newKey !== null,
    newKey,
    newMime,
    newSize,
    thumbKey,
    dominantColor,
  };
}

