import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { outputKeys, reencode, useOfKey } from "./reencode";

const still = (width: number, height: number, format: "png" | "jpeg" = "png") =>
  sharp({ create: { width, height, channels: 3, background: "#3a7bd5" } })[format]().toBuffer();

const animatedGif = async (width: number, height: number, colours = ["#f00", "#0f0", "#00f"]) => {
  const frames = await Promise.all(
    colours.map((c) => sharp({ create: { width, height, channels: 4, background: c } }).png().toBuffer()),
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: colours.map(() => 100) }).toBuffer();
};

describe("useOfKey", () => {
  it("reads the use off the quarantine prefix, and nothing outside quarantine", () => {
    assert.equal(useOfKey("quarantine/banners/abc"), "banner");
    assert.equal(useOfKey("quarantine/avatars/abc"), "avatar");
    assert.equal(useOfKey("quarantine/emojis/abc"), "emoji");
    assert.equal(useOfKey("quarantine/uploads/abc.png"), "upload");
    assert.equal(useOfKey("uploads/abc.png"), null);
    assert.equal(useOfKey("quarantine/other/abc"), null);
  });
});

describe("reencode", () => {
  it("writes a still upload out again as AVIF at its own size, never as the bytes that came in", async () => {
    const input = await still(1200, 800);
    const out = await reencode(input, "upload");
    assert.equal(out.mime, "image/avif");
    assert.deepEqual([out.width, out.height], [1200, 800]);
    assert.notDeepEqual(out.body, input);
    assert.equal((await sharp(out.body).metadata()).format, "heif");
    assert.ok(out.thumb);
  });

  it("cuts a banner to the card's own shape", async () => {
    const out = await reencode(await still(1500, 1500, "jpeg"), "banner");
    assert.deepEqual([out.width, out.height], [960, 492]);
    const thumb = await sharp(out.thumb!).metadata();
    assert.deepEqual([thumb.width, thumb.height], [480, 246]);
  });

  it("cuts an avatar square, with a 128px thumbnail", async () => {
    const out = await reencode(await still(640, 300), "avatar");
    assert.deepEqual([out.width, out.height], [256, 256]);
    assert.equal(out.thumbPx, 128);
  });

  it("shrinks an emoji to fit 128px and keeps its shape, with no thumbnail", async () => {
    const out = await reencode(await still(500, 200), "emoji");
    assert.deepEqual([out.width, out.height], [128, 51]);
    assert.equal(out.thumb, null);
  });

  it("keeps an animation animated, every frame written out again at one size", async () => {
    const out = await reencode(await animatedGif(300, 200), "banner");
    assert.equal(out.mime, "image/webp");
    assert.equal(out.animated, true);
    const meta = await sharp(out.body, { animated: true }).metadata();
    assert.equal(meta.pages, 3);
    assert.deepEqual([meta.width, meta.pageHeight], [960, 492]);
    assert.deepEqual([out.width, out.height], [960, 492]);
  });

  it("refuses what it cannot decode, so the file stays in quarantine", async () => {
    await assert.rejects(reencode(Buffer.alloc(0), "upload"));
    await assert.rejects(reencode(Buffer.from("not an image at all"), "upload"));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await assert.rejects(reencode(svg, "avatar"));
    const png = await still(64, 64);
    await assert.rejects(reencode(png.subarray(0, png.length - 40), "upload"), "a truncated file is not half-served");
  });
});

describe("outputKeys", () => {
  it("puts each use under its own prefix, outside quarantine", () => {
    assert.deepEqual(outputKeys("banner", "f1", "avif"), { key: "banners/f1.avif", thumbKey: "thumbnails/f1.avif" });
    assert.equal(outputKeys("upload", "f2", "webp").key, "uploads/f2.webp");
  });
});
