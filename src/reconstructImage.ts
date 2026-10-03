import sharp from "sharp";

const MAX_INPUT_PIXELS = 100_000_000;
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export function checkMediaSize(bytes: number, maxBytes: number): void {
  if (bytes > MAX_MEDIA_BYTES || (maxBytes > 0 && bytes > maxBytes)) throw new Error("Media exceeds processing limit");
}

export interface RasterTransform { width: number; height: number; thumbWidth: number; thumbHeight: number; maxFrames: number; fit: "cover" | "inside" }

export function validateTransform(value: RasterTransform): void {
  for (const number of [value.width, value.height, value.thumbWidth, value.thumbHeight]) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2048) throw new Error("Invalid raster dimensions");
  }
  if (!Number.isSafeInteger(value.maxFrames) || value.maxFrames < 1 || value.maxFrames > 480 || !["cover", "inside"].includes(value.fit)) throw new Error("Invalid raster transform");
}

export async function reconstructImage(bytes: Buffer, maxBytes: number, banner: boolean, thumbWidth = 320, squareThumb = false, transform?: RasterTransform) {
  checkMediaSize(bytes.length, maxBytes);
  const header = bytes.subarray(0, 32);
  const raster = header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    || header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || /^GIF8[79]a/.test(header.subarray(0, 6).toString("ascii"))
    || (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP")
    || (header.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis|heic|heix|hevc|hevx|mif1|msf1/.test(header.subarray(8).toString("ascii")))
    || (!banner && (header.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || header.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))));
  if (!raster) throw new Error(banner ? "Unsupported banner format" : "Unsupported image format");
  const options = { failOn: "error" as const, limitInputPixels: MAX_INPUT_PIXELS, animated: true };
  const metadata = await sharp(bytes, options).metadata();
  if (!metadata.format || !["jpeg", "png", "gif", "webp", "avif", "heif", "tiff"].includes(metadata.format)) throw new Error("Unsupported image format");
  const pipeline = sharp(bytes, options);
  if (transform) {
    validateTransform(transform);
    if ((metadata.pages ?? 1) > transform.maxFrames) throw new Error("Image exceeds animation frame limit");
    pipeline.resize({ width: transform.width, height: transform.height, fit: transform.fit, withoutEnlargement: transform.fit === "inside" });
  }
  if (banner) pipeline.resize({ width: 960, height: 384, fit: "cover" });
  // Reconstruction is mandatory, even when the result is larger than the original.
  const mime = transform && (metadata.pages ?? 1) === 1 ? "image/avif" : "image/webp";
  const body = await (mime === "image/avif" ? pipeline.avif({ quality: 85 }) : pipeline.webp({ quality: 85 })).toBuffer();
  checkMediaSize(body.length, maxBytes);
  const output = await sharp(body, options).metadata();
  if ((output.pages ?? 1) !== (metadata.pages ?? 1)) throw new Error("Image animation could not be preserved");
  const firstFrame = sharp(body, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 });
  const thumb = await firstFrame.clone().resize(transform ? { width: transform.thumbWidth, height: transform.thumbHeight, fit: "cover" } : squareThumb ? { width: thumbWidth, height: thumbWidth, fit: "cover" } : { width: thumbWidth, withoutEnlargement: true }).avif({ quality: 50 }).toBuffer();
  const { dominant } = await firstFrame.stats();
  const dominantColor = `#${[dominant.r, dominant.g, dominant.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return { body, thumb, mime, dominantColor, animated: (metadata.pages ?? 1) > 1, width: output.width!, height: output.pageHeight ?? output.height! };
}

export async function reconstructPoster(bytes: Buffer) {
  checkMediaSize(bytes.length, 0);
  const body = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 }).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const output = await sharp(body).metadata();
  return { body, thumb: body, mime: "image/jpeg", dominantColor: "#000000", animated: false, width: output.width!, height: output.height! };
}
