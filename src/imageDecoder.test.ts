import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageResult, reconstructUploadedImage } from "./imageDecoder";

test("rejects malformed or unbounded raster decoder responses", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([255, 255, 255, 255]), Buffer.from([0, 0, 0, 1, 123])]) {
    assert.throws(() => parseImageResult(bytes));
  }
  const header = Buffer.from(JSON.stringify({ bodyBytes: -1, thumbBytes: 1, dominantColor: "#000000" }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  assert.throws(() => parseImageResult(Buffer.concat([length, header])));
});

test("production images fail closed when no raster jail is configured", async () => {
  const oldEnvironment = process.env.NODE_ENV;
  const oldSocket = process.env.IMAGEJAIL_SOCKET;
  process.env.NODE_ENV = "production";
  delete process.env.IMAGEJAIL_SOCKET;
  try {
    await assert.rejects(reconstructUploadedImage(Buffer.from("image"), 100, false), /isolated decoder/);
  } finally {
    if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
    if (oldSocket === undefined) delete process.env.IMAGEJAIL_SOCKET; else process.env.IMAGEJAIL_SOCKET = oldSocket;
  }
});
