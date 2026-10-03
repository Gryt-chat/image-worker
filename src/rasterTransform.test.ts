import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { reconstructImage, validateTransform } from "./reconstructImage";

test("avatar and icon transforms preserve their square and thumbnail sizes", async () => {
  const input = await sharp({ create: { width: 800, height: 400, channels: 3, background: "red" } }).png().toBuffer();
  const result = await reconstructImage(input, 1048576, false, 320, false, { width: 256, height: 256, thumbWidth: 128, thumbHeight: 128, fit: "cover", maxFrames: 480 });
  assert.equal(result.mime, "image/avif");
  assert.deepEqual([result.width, result.height], [256, 256]);
  const thumb = await sharp(result.thumb).metadata();
  assert.deepEqual([thumb.width, thumb.height], [128, 128]);
});

test("emoji transforms keep aspect ratio and do not enlarge small inputs", async () => {
  const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: "blue" } }).png().toBuffer();
  const result = await reconstructImage(input, 1048576, false, 320, false, { width: 128, height: 128, thumbWidth: 128, thumbHeight: 128, fit: "inside", maxFrames: 480 });
  assert.deepEqual([result.width, result.height], [80, 40]);
});

test("animated avatars are reconstructed frame by frame and frame limits fail closed", async () => {
  const pixels = Buffer.alloc(20 * 40 * 3, 128);
  pixels.fill(255, 20 * 20 * 3);
  const input = await sharp(pixels, { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
  const spec = { width: 256, height: 256, thumbWidth: 128, thumbHeight: 128, fit: "cover" as const, maxFrames: 480 };
  const result = await reconstructImage(input, 1048576, false, 320, false, spec);
  assert.equal(result.mime, "image/webp");
  assert.equal((await sharp(result.body, { animated: true }).metadata()).pages, 2);
  assert.equal(result.height, 256);
  await assert.rejects(reconstructImage(input, 1048576, false, 320, false, { ...spec, maxFrames: 1 }), /frame limit/);
  assert.throws(() => validateTransform({ ...spec, width: 1000000 }));
});
