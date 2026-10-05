/* The jail's answer: a 4-byte header length, a JSON header, then the file and its thumbnail.
   Read back as untrusted, since it came out of the process that touched the upload. */
import type { Reencoded } from "./reencode";

export interface JailResult extends Reencoded {
  dominantColor: string | null;
}

const MIMES = new Set(["image/avif", "image/webp"]);

export function packResult(out: Reencoded, dominantColor: string | null): Buffer {
  const thumb = out.thumb ?? Buffer.alloc(0);
  const header = Buffer.from(JSON.stringify({
    bodyBytes: out.body.length, thumbBytes: thumb.length, mime: out.mime, ext: out.ext,
    width: out.width, height: out.height, animated: out.animated, thumbPx: out.thumbPx, dominantColor,
  }));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, out.body, thumb]);
}

const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

export function unpackResult(bytes: Buffer): JailResult {
  if (bytes.length < 4) throw new Error("Incomplete result from the image jail");
  const length = bytes.readUInt32BE(0);
  if (length === 0 || length > 2048 || bytes.length < 4 + length) throw new Error("Bad header from the image jail");
  const h = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
  const thumbBytes = h.thumbBytes;
  if (!positive(h.bodyBytes) || !Number.isSafeInteger(thumbBytes) || (thumbBytes as number) < 0
    || !positive(h.width) || !positive(h.height) || h.width > 8192 || h.height > 8192
    || typeof h.mime !== "string" || !MIMES.has(h.mime) || (h.ext !== "avif" && h.ext !== "webp")
    || typeof h.animated !== "boolean"
    || !(h.thumbPx === null || positive(h.thumbPx))
    || !(h.dominantColor === null || (typeof h.dominantColor === "string" && /^#[0-9a-f]{6}$/.test(h.dominantColor)))
    || bytes.length !== 4 + length + (h.bodyBytes as number) + (thumbBytes as number)) {
    throw new Error("Bad result from the image jail");
  }
  const start = 4 + length;
  const end = start + (h.bodyBytes as number);
  return {
    body: bytes.subarray(start, end),
    thumb: thumbBytes ? bytes.subarray(end) : null,
    mime: h.mime,
    ext: h.ext,
    width: h.width,
    height: h.height,
    animated: h.animated,
    thumbPx: h.thumbPx as number | null,
    dominantColor: h.dominantColor as string | null,
  };
}
