import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMediaSize, reconstructImage, reconstructPoster } from "./reconstructImage";
import type { RasterTransform } from "./reconstructImage";
import { findExecutable, runDecoder } from "./videoPoster";

export function parseImageResult(bytes: Buffer) {
  if (bytes.length < 4) throw new Error("Incomplete image decoder result");
  const length = bytes.readUInt32BE(0);
  if (length > 1024 || bytes.length < 4 + length) throw new Error("Invalid image decoder header");
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
  if (!Number.isSafeInteger(header.bodyBytes) || header.bodyBytes <= 0 || !Number.isSafeInteger(header.thumbBytes) || header.thumbBytes <= 0
    || !Number.isSafeInteger(header.width) || header.width <= 0 || !Number.isSafeInteger(header.height) || header.height <= 0
    || !["image/avif", "image/webp", "image/jpeg"].includes(header.mime)
    || typeof header.animated !== "boolean" || !/^#[a-f0-9]{6}$/.test(header.dominantColor) || bytes.length !== 4 + length + header.bodyBytes + header.thumbBytes) throw new Error("Invalid image decoder result");
  const offset = 4 + length;
  return { body: bytes.subarray(offset, offset + header.bodyBytes), thumb: bytes.subarray(offset + header.bodyBytes), mime: header.mime as string, dominantColor: header.dominantColor as string, animated: header.animated as boolean, width: header.width as number, height: header.height as number };
}

export async function reconstructUploadedImage(bytes: Buffer, maxBytes: number, banner: boolean, thumbWidth = 320, mode?: "avatar-thumb" | "poster", transform?: RasterTransform) {
  checkMediaSize(bytes.length, maxBytes);
  if (!Number.isSafeInteger(thumbWidth) || thumbWidth < 1 || thumbWidth > 1024) throw new Error("Invalid thumbnail size");
  const socket = process.env.IMAGEJAIL_SOCKET;
  if (!socket) {
    if (process.env.NODE_ENV === "production") throw new Error("Uploaded images require an isolated decoder");
    return mode === "poster" ? reconstructPoster(bytes) : reconstructImage(bytes, maxBytes, banner, thumbWidth, mode === "avatar-thumb", transform);
  }
  const client = findExecutable("ffjail");
  if (!client) throw new Error("Image decoder jail unavailable");
  const dir = await mkdtemp(join(tmpdir(), "gryt-image-"));
  try {
    const input = join(dir, "input");
    await writeFile(input, bytes, { mode: 0o600, flag: "wx" });
    const result = await runDecoder(client, ["run", socket, String(16 * 1024 * 1024 * 1024), "30000", "--", "--jitless", "--max-old-space-size=256", "--disable-wasm-trap-handler", "/decoder/imageDecoderEntry.js", String(maxBytes), mode ?? (banner ? "banner" : "image"), String(thumbWidth), JSON.stringify(transform ?? null)], input, 31_000);
    if (result.timedOut || result.tooBig || result.code !== 0) throw new Error("Isolated image reconstruction failed");
    const decoded = parseImageResult(result.stdout);
    checkMediaSize(decoded.body.length, maxBytes);
    return decoded;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
