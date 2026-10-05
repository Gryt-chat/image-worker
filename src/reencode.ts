/** Uploads under `quarantine/` are never served as sent: each is decoded and written out again
 *  at the size its use needs, and only the new file reaches anybody (GRYT-1664). */

import sharp from "sharp";

const MAX_INPUT_PIXELS = 100_000_000;
/** Past this a file is not decoded at all, whatever the server's upload limit says. */
export const MAX_QUARANTINE_BYTES = 64 * 1024 * 1024;

export type Use = "upload" | "banner" | "avatar" | "emoji";

interface Profile {
  prefix: string;
  /** "cover" cuts to exactly this box; "inside" only shrinks to fit it. */
  fit: "cover" | "inside";
  width: number;
  height: number;
  /** Animated output is capped smaller: every frame costs. */
  animatedMax: number;
  thumb: { width: number; height?: number } | null;
}

/* The banner box matches the card's 320 by 164 at 3x, as the server's BANNER_BOX does. */
const PROFILES: Record<Use, Profile> = {
  upload: { prefix: "uploads", fit: "inside", width: 4096, height: 4096, animatedMax: 1024, thumb: { width: 320 } },
  banner: { prefix: "banners", fit: "cover", width: 960, height: 492, animatedMax: 960, thumb: { width: 480, height: 246 } },
  avatar: { prefix: "avatars", fit: "cover", width: 256, height: 256, animatedMax: 256, thumb: { width: 128, height: 128 } },
  // 128 tall at any width up to 512, as the server's own emoji step drew them, so a wide one stays wide.
  emoji: { prefix: "emojis", fit: "inside", width: 512, height: 128, animatedMax: 512, thumb: null },
};

const QUARANTINE_USE: Array<[string, Use]> = [
  ["quarantine/banners/", "banner"],
  ["quarantine/avatars/", "avatar"],
  ["quarantine/emojis/", "emoji"],
  ["quarantine/uploads/", "upload"],
];

/** The use a quarantined key is for, or null for a key outside quarantine. */
export function useOfKey(key: string): Use | null {
  for (const [prefix, use] of QUARANTINE_USE) if (key.startsWith(prefix)) return use;
  return null;
}

const ACCEPTED = new Set(["jpeg", "png", "gif", "webp", "heif"]);

export interface Reencoded {
  body: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
  animated: boolean;
  thumb: Buffer | null;
  thumbPx: number | null;
}

/** Twenty seconds at 15 fps, which covers what people use as an animated avatar or emoji. */
export const MAX_ANIMATED_FRAMES = 300;

/**
 * Decode and write out again. Throws on anything it cannot decode in full, so the
 * job fails and the original stays in quarantine, unserved.
 */
export async function reencode(bytes: Buffer, use: Use): Promise<Reencoded> {
  if (bytes.length === 0 || bytes.length > MAX_QUARANTINE_BYTES) throw new Error("File is empty or too large to process");
  const profile = PROFILES[use];
  const open = (pages: number) =>
    sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages });

  const meta = await open(-1).metadata();
  // heif covers AVIF; HEIC photos decode only where libvips was built with it.
  if (!meta.format || !ACCEPTED.has(meta.format)) throw new Error(`Unsupported image format: ${meta.format ?? "unknown"}`);
  const animated = (meta.pages ?? 1) > 1 && (meta.format === "gif" || meta.format === "webp");

  const side = animated ? profile.animatedMax : null;
  const box = {
    width: side ? Math.min(profile.width, side) : profile.width,
    height: side ? Math.min(profile.height, side) : profile.height,
  };
  // Every frame goes through the resize, so a frame that claims another size comes out at this one.
  // Only the first frames are read: a 1,500-frame GIF came out as a 7 MB avatar.
  const pipeline = open(animated ? Math.min(meta.pages ?? 1, MAX_ANIMATED_FRAMES) : 1).rotate().resize({
    width: box.width,
    height: box.height,
    fit: profile.fit,
    withoutEnlargement: profile.fit === "inside",
  });

  const out = animated
    ? await pipeline.webp({ quality: 75, effort: 4, loop: 0 }).toBuffer({ resolveWithObject: true })
    : await pipeline.avif({ quality: 60, effort: 4 }).toBuffer({ resolveWithObject: true });

  let thumb: Buffer | null = null;
  if (profile.thumb) {
    thumb = await sharp(out.data, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .resize({ width: profile.thumb.width, height: profile.thumb.height, fit: "cover", withoutEnlargement: !profile.thumb.height })
      .avif({ quality: 50 })
      .toBuffer();
  }

  return {
    body: out.data,
    mime: animated ? "image/webp" : "image/avif",
    ext: animated ? "webp" : "avif",
    width: out.info.width,
    // An animated WebP stacks its frames; one frame's height is the picture's.
    height: animated ? Math.round(out.info.height / Math.max(1, out.info.pages ?? meta.pages ?? 1)) : out.info.height,
    animated,
    thumb,
    thumbPx: profile.thumb?.width ?? null,
  };
}

/** Where the written-out file and its thumbnail go. */
export function outputKeys(use: Use, fileId: string, ext: string, thumbExt = "avif"): { key: string; thumbKey: string } {
  return { key: `${PROFILES[use].prefix}/${fileId}.${ext}`, thumbKey: `thumbnails/${fileId}.${thumbExt}` };
}
