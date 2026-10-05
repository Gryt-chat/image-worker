import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkChatVideoAnswer, checkImageAnswer, checkPosterAnswer, checkVideoAnswer, hasDesktopSandbox } from "./desktopSandbox";

const webp = () => new Uint8Array(Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(8)]));
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const mp4 = () => new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(8)]));

const image = () => ({
  ok: true, kind: "image", body: webp(), mime: "image/webp", width: 256, height: 256,
  animated: false, thumb: webp(), thumbPx: 128, colour: "#a0b0c0",
});

describe("hasDesktopSandbox", () => {
  it("needs the app's flag and a live IPC channel", () => {
    const proc = { send: () => true, connected: true } as never;
    assert.equal(hasDesktopSandbox({ GRYT_MEDIA_SANDBOX: "ipc" }, proc), true);
    assert.equal(hasDesktopSandbox({}, proc), false);
    assert.equal(hasDesktopSandbox({ GRYT_MEDIA_SANDBOX: "ipc" }, { send: undefined, connected: false } as never), false);
    assert.equal(hasDesktopSandbox({ GRYT_MEDIA_SANDBOX: "ipc" }, { send: () => true, connected: false } as never), false);
  });
});

describe("checkImageAnswer", () => {
  it("takes a well-formed answer, with WebP thumbnails", () => {
    const out = checkImageAnswer(image());
    assert.equal(out.ext, "webp");
    assert.equal(out.thumbMime, "image/webp");
    assert.equal(out.dominantColor, "#a0b0c0");
    assert.ok(Buffer.isBuffer(out.body));
  });

  it("passes on the sandbox's refusal, shortened", () => {
    assert.throws(() => checkImageAnswer({ ok: false, reason: "x".repeat(500) }), (e: Error) => e.message.length === 200);
  });

  for (const [name, patch] of [
    ["a body that isn't WebP", { body: jpeg() }],
    ["an empty body", { body: new Uint8Array() }],
    ["a thumbnail that isn't WebP", { thumb: jpeg() }],
    ["another mime", { mime: "image/svg+xml" }],
    ["a huge width", { width: 100_000 }],
    ["a fractional height", { height: 1.5 }],
    ["a colour that isn't hex", { colour: "red; background:url(x)" }],
    ["a video in an image answer", { kind: "video" }],
    ["bytes as a plain array", { body: [1, 2, 3] }],
  ] as const) {
    it(`refuses ${name}`, () => assert.throws(() => checkImageAnswer({ ...image(), ...patch }), /Bad result/));
  }
});

describe("checkVideoAnswer", () => {
  const video = { ok: true, kind: "video", video: mp4(), poster: jpeg(), width: 960, height: 492 };

  it("takes an MP4 at the box size", () => {
    assert.equal(checkVideoAnswer(video, "banner").width, 960);
  });

  it("refuses another size, a non-MP4 or a non-JPEG poster", () => {
    assert.throws(() => checkVideoAnswer(video, "avatar"), /Bad result/);
    assert.throws(() => checkVideoAnswer({ ...video, video: webp() }, "banner"), /Bad result/);
    assert.throws(() => checkVideoAnswer({ ...video, poster: webp() }, "banner"), /Bad result/);
  });
});

describe("checkPosterAnswer", () => {
  const poster = { ok: true, kind: "poster", poster: jpeg(), width: 320, height: 180 };

  it("takes a JPEG no wider than 320px", () => {
    assert.ok(Buffer.isBuffer(checkPosterAnswer(poster)));
  });

  it("refuses a wider poster, another format, or another kind of answer", () => {
    assert.throws(() => checkPosterAnswer({ ...poster, width: 1920 }), /Bad result/);
    assert.throws(() => checkPosterAnswer({ ...poster, poster: webp() }), /Bad result/);
    assert.throws(() => checkPosterAnswer({ ...poster, kind: "video" }), /Bad result/);
  });
});

describe("checkChatVideoAnswer", () => {
  const answer = { ok: true, kind: "chatvideo", video: mp4(), poster: jpeg(), width: 1280, height: 720 };

  it("takes an MP4 inside 1280px with a JPEG poster", () => {
    assert.equal(checkChatVideoAnswer(answer).width, 1280);
  });

  it("refuses one past the box, or another kind of answer", () => {
    assert.throws(() => checkChatVideoAnswer({ ...answer, width: 1920 }), /Bad result/);
    assert.throws(() => checkChatVideoAnswer({ ...answer, kind: "video" }), /Bad result/);
  });
});
