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

/* Never throws: a colour is a nicety and must not fail the upload. */
export async function findDominantColor(
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
  if (rawKey.startsWith("quarantine/banners/") && (rawBytes > 64 * 1024 * 1024 || (maxBytes > 0 && rawBytes > maxBytes))) {
    throw new Error("Banner exceeds processing limit");
  }
  const rawBuffer = await getObjectAsBuffer(bucket, rawKey);

  if (rawKey.startsWith("quarantine/banners/")) {
    return processBannerImage(bucket, fileId, rawBuffer, maxBytes);
  }

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

export async function processBannerImage(bucket: string, fileId: string, bytes: Buffer, maxBytes: number): Promise<ProcessResult> {
  if (bytes.length > 64 * 1024 * 1024 || (maxBytes > 0 && bytes.length > maxBytes)) throw new Error("Banner exceeds processing limit");
  const rasterHeader = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
    || (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    || (bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 32).toString("ascii")));
  if (!rasterHeader) throw new Error("Unsupported banner format");
  const options = { failOn: "error" as const, limitInputPixels: MAX_INPUT_PIXELS, animated: true };
  const metadata = await sharp(bytes, options).metadata();
  if (!metadata.format || !["jpeg", "png", "gif", "webp", "avif", "heif"].includes(metadata.format)) throw new Error("Unsupported banner format");
  const animated = (metadata.pages ?? 1) > 1;
  // Re-encode every frame rather than exposing an untrusted original.
  const body = await sharp(bytes, options).resize({ width: 960, height: 384, fit: "cover" }).webp({ quality: 85 }).toBuffer();
  if (maxBytes > 0 && body.length > maxBytes) throw new Error("Processed banner exceeds upload limit");
  const newKey = `banners/verified/${fileId}.webp`;
  const thumbKey = `thumbnails/${fileId}.avif`;
  const thumb = await sharp(body, { ...options, animated: false, pages: 1 }).resize({ width: 320 }).avif({ quality: 50 }).toBuffer();
  await putObject(bucket, newKey, body, "image/webp");
  await putObject(bucket, thumbKey, thumb, "image/avif");
  return { compressed: true, newKey, newMime: "image/webp", newSize: body.length, thumbKey,
    dominantColor: await findDominantColor(body, animated) };
}
