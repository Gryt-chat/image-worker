import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import sharp from "sharp";

import { initStorage } from "./storage";
import {
  CODEC_WHITELIST,
  FORMAT_WHITELIST,
  ffmpegArgs,
  findFrameTools,
  frameCommand,
  grabFrame,
  posterFromFrame,
  processUploadedVideo,
} from "./videoPoster";

const tools = findFrameTools();
// CI installs ffmpeg, so there a missing one is a failure rather than a skip.
const skip = !tools.ffmpeg && process.env.CI !== "true" ? "ffmpeg is not installed here" : false;

const dir = mkdtempSync(join(tmpdir(), "gryt-test-poster-"));
const at = (name: string) => join(dir, name);

/** Made with the unconfined ffmpeg: this is the uploader's side, not the worker's. */
function make(name: string, args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, at(name)]);
}

function lavfi(seconds: number): string[] {
  return ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`];
}

describe("the ffmpeg command", () => {
  it("confines the input before it is opened", () => {
    const args = ffmpegArgs(1);
    const input = args.indexOf("-i");
    const before = args.slice(0, input);

    for (const [flag, value] of [
      ["-protocol_whitelist", "fd"],
      ["-fd", "3"],
      ["-format_whitelist", "mov,mp4,matroska,webm"],
      ["-codec_whitelist", "h264,hevc,vp8,vp9,libdav1d"],
      ["-threads", "1"],
    ]) {
      assert.equal(before[before.indexOf(flag) + 1], value, `${flag} is missing or after -i`);
    }
    assert.equal(FORMAT_WHITELIST, "mov,mp4,matroska,webm");
    assert.equal(CODEC_WHITELIST, "h264,hevc,vp8,vp9,libdav1d");
    assert.equal(args[input + 1], "fd:", "the input is fd 3, never a path or a URL");
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
    assert.equal(args[args.lastIndexOf("-threads") + 1], "1", "the encoder threads too");
    assert.ok(args.lastIndexOf("-threads") > input);
    assert.equal(args.at(-1), "pipe:1");
  });

  it("seeks no later than one second", () => {
    assert.equal(ffmpegArgs(1)[ffmpegArgs(1).indexOf("-ss") + 1], "1");
    assert.equal(ffmpegArgs(0)[ffmpegArgs(0).indexOf("-ss") + 1], "0");
  });

  it("runs under prlimit when there is one", () => {
    const cmd = frameCommand({ ffmpeg: "/usr/bin/ffmpeg", prlimit: "/usr/bin/prlimit" }, ["-x"], "linux", 1234);
    assert.deepEqual(cmd, { cmd: "/usr/bin/prlimit", argv: ["--as=1234", "--", "/usr/bin/ffmpeg", "-x"] });
  });

  it("refuses to run uncapped on Linux", () => {
    const cmd = frameCommand({ ffmpeg: "/usr/bin/ffmpeg", prlimit: null }, [], "linux");
    assert.ok("missing" in cmd && /prlimit/.test(cmd.missing));
  });

  it("runs ffmpeg directly on a dev machine without prlimit", () => {
    const cmd = frameCommand({ ffmpeg: "/opt/homebrew/bin/ffmpeg", prlimit: null }, ["-x"], "darwin");
    assert.deepEqual(cmd, { cmd: "/opt/homebrew/bin/ffmpeg", argv: ["-x"] });
  });
});

describe("without ffmpeg", () => {
  it("finds nothing on an empty PATH", () => {
    assert.deepEqual(findFrameTools(""), { ffmpeg: null, prlimit: null });
  });

  it("gives no poster, is not a refusal, and does not fetch the video", async () => {
    // Storage is not initialised here, so a download attempt would throw.
    const result = await processUploadedVideo("b", "f", "uploads/f.mp4", { ffmpeg: null, prlimit: null });
    assert.deepEqual(result, { thumbKey: null, refused: false, reason: "ffmpeg is not installed" });
  });

  it("reports a binary that will not start rather than throwing", async () => {
    const result = await grabFrame("/nonexistent", { ffmpeg: "/nonexistent/ffmpeg", prlimit: null });
    assert.equal(result.ok, false);
  });
});

describe("with the real ffmpeg", { skip }, () => {
  before(() => {
    make("h264.mp4", [...lavfi(3), "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
    make("vp9.webm", [...lavfi(3), "-c:v", "libvpx-vp9", "-b:v", "300k"]);
    make("short.mp4", [...lavfi(0.5), "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    make("clip.avi", [...lavfi(2), "-c:v", "mpeg4"]);
    make("clip.flv", [...lavfi(2), "-c:v", "flv1"]);
    make("mpeg4.mp4", [...lavfi(2), "-c:v", "mpeg4"]);
    make("frame.png", ["-f", "lavfi", "-i", "testsrc2=size=64x64", "-frames:v", "1"]);

    writeFileSync(at("png.mp4"), readFileSync(at("frame.png")));
    writeFileSync(at("text.mp4"), "this is not a video\n");
    writeFileSync(at("truncated.mp4"), readFileSync(at("h264.mp4")).subarray(0, 40_000));
  });

  for (const name of ["h264.mp4", "vp9.webm"]) {
    it(`makes a JPEG poster from ${name}`, async () => {
      const grabbed = await grabFrame(at(name), tools);
      assert.ok(grabbed.ok, grabbed.ok ? "" : grabbed.reason);

      const poster = await posterFromFrame(grabbed.frame);
      const meta = await sharp(poster).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, 320);
    });
  }

  it("falls back to the first frame of a clip shorter than a second", async () => {
    const grabbed = await grabFrame(at("short.mp4"), tools);
    assert.ok(grabbed.ok, grabbed.ok ? "" : grabbed.reason);
  });

  for (const [name, why] of [
    ["clip.avi", /Format not on whitelist/],
    ["clip.flv", /Format not on whitelist/],
    ["png.mp4", /Format not on whitelist/],
    ["mpeg4.mp4", /not on whitelist|no video frame/],
    ["text.mp4", /Invalid data|moov atom/],
    ["truncated.mp4", /Invalid data|moov atom/],
  ] as const) {
    it(`refuses ${name} and says why`, async () => {
      const grabbed = await grabFrame(at(name), tools);
      assert.equal(grabbed.ok, false);
      if (grabbed.ok) return;
      assert.equal(grabbed.refused, true);
      assert.match(grabbed.reason, why);
      assert.ok(!grabbed.reason.includes(dir), "the reason carries our temp path");
    });
  }

  it("kills ffmpeg at the time cap", async () => {
    const grabbed = await grabFrame(at("h264.mp4"), tools, { timeoutMs: 1 });
    assert.deepEqual(grabbed, { ok: false, refused: true, reason: "ffmpeg ran past 1ms" });
  });

  it("fits a 4K frame under the default memory cap", async () => {
    make("h264-4k.mp4", ["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=1.2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
    const grabbed = await grabFrame(at("h264-4k.mp4"), tools);
    assert.ok(grabbed.ok, grabbed.ok ? "" : grabbed.reason);
  });

  it("is stopped by the memory cap", { skip: tools.prlimit ? false : "no prlimit here" }, async () => {
    const grabbed = await grabFrame(at("h264.mp4"), tools, { memoryBytes: 16 * 1024 * 1024 });
    assert.equal(grabbed.ok, false);
  });

  it("stores the poster where the server looks and leaves no temp files", async () => {
    const data = mkdtempSync(join(tmpdir(), "gryt-test-data-"));
    mkdirSync(join(data, "bucket", "uploads"), { recursive: true });
    writeFileSync(join(data, "bucket", "uploads", "f1.mp4"), readFileSync(at("h264.mp4")));
    process.env.STORAGE_BACKEND = "filesystem";
    process.env.DATA_DIR = data;
    await initStorage();

    const leftover = () => readdirSync(tmpdir()).filter((n) => /^gryt-poster-/.test(n)).length;
    const beforeCount = leftover();

    const result = await processUploadedVideo("bucket", "f1", "uploads/f1.mp4", tools);
    assert.deepEqual(result, { thumbKey: "thumbnails/f1.jpg", refused: false, reason: null });
    assert.ok(existsSync(join(data, "bucket", "thumbnails", "f1.jpg")));
    assert.equal(leftover(), beforeCount);
  });
});
