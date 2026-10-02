import { getObjectAsBuffer, putObject } from "./storage";
import { reconstructUploadedImage } from "./imageDecoder";

export interface ProcessResult {
  compressed: boolean;
  newKey: string | null;
  newMime: string | null;
  newSize: number | null;
  thumbKey: string | null;
  /** #rrggbb, or null if the image has no readable colour. */
  dominantColor: string | null;
}

/* Never throws: a colour is a nicety and must not fail the upload. */
export async function findDominantColor(
  buffer: Buffer,
  _animated: boolean,
): Promise<string | null> {
  try {
    return (await reconstructUploadedImage(buffer, 0, false)).dominantColor;
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
  if (rawKey.startsWith("quarantine/") && (rawBytes > 64 * 1024 * 1024 || (maxBytes > 0 && rawBytes > maxBytes))) {
    throw new Error("Banner exceeds processing limit");
  }
  const rawBuffer = await getObjectAsBuffer(bucket, rawKey);

  if (rawKey.startsWith("quarantine/")) {
    const result = await reconstructUploadedImage(rawBuffer, maxBytes, rawKey.startsWith("quarantine/banners/"));
    const newKey = rawKey.startsWith("quarantine/banners/") ? `banners/verified/${fileId}.webp` : `uploads/${fileId}.webp`;
    const thumbKey = `thumbnails/${fileId}.avif`;
    await putObject(bucket, newKey, result.body, "image/webp");
    await putObject(bucket, thumbKey, result.thumb, "image/avif");
    return { compressed: true, newKey, newMime: "image/webp", newSize: result.body.length, thumbKey, dominantColor: result.dominantColor };
  }

  const mimeStr = rawContentType.toLowerCase();
  const isGif = mimeStr === "image/gif";
  const isWebp = mimeStr === "image/webp";
  const isAvif = mimeStr === "image/avif";
  const result = await reconstructUploadedImage(rawBuffer, 0, false);
  const shouldKeepOriginal = isGif || isAvif || (isWebp && result.animated);

  let newKey: string | null = null;
  let newMime: string | null = null;
  let newSize: number | null = null;
  const hasLimit = typeof maxBytes === "number" && maxBytes > 0;

  if (!shouldKeepOriginal && hasLimit && rawBytes > maxBytes) {
    if (result.body.length < rawBuffer.length && result.body.length <= maxBytes) {
      newKey = `uploads/${fileId}.webp`;
      newMime = "image/webp";
      newSize = result.body.length;
      await putObject(bucket, newKey, result.body, "image/webp");

    }
  }

  const thumbKey = `thumbnails/${fileId}.avif`;
  await putObject(bucket, thumbKey, result.thumb, "image/avif");

  return {
    compressed: newKey !== null,
    newKey,
    newMime,
    newSize,
    thumbKey,
    dominantColor: result.dominantColor,
  };
}

export async function processBannerImage(bucket: string, fileId: string, bytes: Buffer, maxBytes: number): Promise<ProcessResult> {
  const result = await reconstructUploadedImage(bytes, maxBytes, true);
  const newKey = `banners/verified/${fileId}.webp`;
  const thumbKey = `thumbnails/${fileId}.avif`;
  await putObject(bucket, newKey, result.body, "image/webp");
  await putObject(bucket, thumbKey, result.thumb, "image/avif");
  return { compressed: true, newKey, newMime: "image/webp", newSize: result.body.length, thumbKey, dominantColor: result.dominantColor };
}
