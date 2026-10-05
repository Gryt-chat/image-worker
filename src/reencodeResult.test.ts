import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { reencodeInJail } from "./jailedReencode";
import { reencode } from "./reencode";
import { packResult, unpackResult } from "./reencodeResult";

const png = () => sharp({ create: { width: 300, height: 200, channels: 3, background: "#d94" } }).png().toBuffer();

describe("the image jail's answer", () => {
  it("reads back what the jail wrote", async () => {
    const out = await reencode(await png(), "avatar");
    const back = unpackResult(packResult(out, "#dd9944"));
    assert.deepEqual(back.body, out.body);
    assert.deepEqual(back.thumb, out.thumb);
    assert.deepEqual([back.mime, back.width, back.height, back.dominantColor], [out.mime, 256, 256, "#dd9944"]);
  });

  it("refuses an answer that does not add up, since it came from the process that touched the upload", async () => {
    const good = packResult(await reencode(await png(), "emoji"), null);
    assert.throws(() => unpackResult(good.subarray(0, good.length - 1)), "short body");
    assert.throws(() => unpackResult(Buffer.concat([good, Buffer.from([0])])), "trailing bytes");
    assert.throws(() => unpackResult(Buffer.from([0, 0, 0, 0])), "empty header");
    const header = (h: object) => {
      const json = Buffer.from(JSON.stringify(h));
      const size = Buffer.alloc(4);
      size.writeUInt32BE(json.length);
      return Buffer.concat([size, json, Buffer.alloc(4)]);
    };
    const base = { bodyBytes: 4, thumbBytes: 0, mime: "image/avif", ext: "avif", width: 10, height: 10, animated: false, thumbPx: null, dominantColor: null };
    assert.doesNotThrow(() => unpackResult(header(base)));
    assert.throws(() => unpackResult(header({ ...base, mime: "image/svg+xml" })));
    assert.throws(() => unpackResult(header({ ...base, ext: "html" })));
    assert.throws(() => unpackResult(header({ ...base, width: 100000 })));
    assert.throws(() => unpackResult(header({ ...base, dominantColor: "red;}" })));
  });
});

describe("reencodeInJail", () => {
  it("re-encodes in process on a dev machine with no jail", async () => {
    const out = await reencodeInJail(await png(), "banner", undefined, false);
    assert.deepEqual([out.width, out.height], [960, 492]);
    assert.match(out.dominantColor ?? "", /^#[0-9a-f]{6}$/);
  });

  it("refuses in production with no jail, so the upload stays in quarantine", async () => {
    await assert.rejects(reencodeInJail(await png(), "banner", undefined, true), /stays in quarantine/);
    await assert.rejects(reencodeInJail(await png(), "banner", "/nonexistent/imagejail.sock", true), /stays in quarantine/);
  });
});
