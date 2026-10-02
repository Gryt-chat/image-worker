import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { processBannerImage, processUploadedImage } from "./processImage";
import { getObjectAsBuffer, initStorage, putObject } from "./storage";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gryt-worker-banner-"));
  process.env.STORAGE_BACKEND = "filesystem";
  process.env.DATA_DIR = dir;
  await initStorage();
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

test("re-encodes a static banner to the exact client crop ratio", async () => {
  const bytes = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "red" } }).png().toBuffer();
  const result = await processBannerImage("test", "static", bytes, 1024 * 1024);
  assert.equal(result.newKey, "banners/verified/static.webp");
  const output = await getObjectAsBuffer("test", result.newKey!);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 960);
  assert.equal(metadata.height, 384);
  assert.notDeepEqual(output, bytes);
  assert.ok(result.thumbKey);
});

test("preserves animation while re-encoding every frame", async () => {
  const pixels = Buffer.alloc(20 * 40 * 3);
  for (let i = 0; i < 20 * 20; i++) { pixels[i * 3] = 255; pixels[(20 * 20 + i) * 3 + 2] = 255; }
  const bytes = await sharp(pixels, { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const result = await processBannerImage("test", "animated", bytes, 1024 * 1024);
  const metadata = await sharp(await getObjectAsBuffer("test", result.newKey!), { animated: true }).metadata();
  assert.equal(metadata.pages, 2);
  assert.equal(metadata.pageHeight, 384);
});

test("rejects malformed bytes, SVG and files above the operator limit", async () => {
  await assert.rejects(processBannerImage("test", "fake", Buffer.from("not an image"), 0));
  await assert.rejects(processBannerImage("test", "svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 0), /Unsupported banner format/);
  await assert.rejects(processBannerImage("test", "big", Buffer.alloc(100), 50), /processing limit/);
});

test("compresses a new chat image only when the output saves storage", async () => {
  const bytes = await sharp({ create: { width: 1000, height: 700, channels: 3, background: "green" } }).png().toBuffer();
  const key = "quarantine/uploads/chat.png";
  await putObject("test", key, bytes, "image/png");
  const result = await processUploadedImage("test", "chat", key, "image/png", bytes.length, 1024 * 1024);
  assert.equal(result.compressed, true);
  assert.equal(result.newMime, "image/avif");
  assert.ok(result.newSize! < bytes.length);
  const output = await sharp(await getObjectAsBuffer("test", result.newKey!)).metadata();
  assert.equal(output.width, 1000);
  assert.equal(output.height, 700);
});
