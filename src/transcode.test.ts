import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatTranscodeArgs, MAX_VIDEO_SECONDS, transcodeArgs } from "./transcode";

describe("transcodeArgs", () => {
  it("drops sound, subtitles and metadata, and cuts at ten seconds", () => {
    const args = transcodeArgs("banner");
    for (const flag of ["-an", "-sn", "-dn"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("-t") + 1], String(MAX_VIDEO_SECONDS));
    assert.equal(args[args.indexOf("-map_metadata") + 1], "-1");
  });

  it("draws every frame into one size and rate, so a stream that changes size comes out one size", () => {
    const filter = (use: "banner" | "avatar") => transcodeArgs(use)[transcodeArgs(use).indexOf("-vf") + 1];
    assert.match(filter("banner"), /^fps=24,scale=960:492:force_original_aspect_ratio=increase.*,crop=960:492,/);
    assert.match(filter("avatar"), /scale=256:256:.*crop=256:256/);
  });

  it("writes AV1 in fragmented MP4 to a pipe, reading only fd 3", () => {
    const args = transcodeArgs("avatar");
    assert.equal(args[args.indexOf("-c:v") + 1], "libsvtav1");
    assert.deepEqual(args.slice(-3), ["-f", "mp4", "pipe:1"]);
    assert.match(args[args.indexOf("-movflags") + 1], /frag_keyframe/);
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "fd,pipe");
  });
});

describe("chatTranscodeArgs", () => {
  const args = chatTranscodeArgs();
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it("keeps the first audio track if there is one, and nothing else from the upload", () => {
    assert.ok(args.includes("0:a:0?"), "an optional audio map, so a silent video still works");
    assert.equal(after("-c:a"), "aac");
    assert.equal(after("-map_metadata"), "-1");
    assert.ok(args.includes("-sn") && args.includes("-dn"));
  });

  it("fits every frame inside 1280px at most 30 fps, and reads only fd 3", () => {
    assert.match(after("-vf"), /min\(1280,iw\).*force_original_aspect_ratio=decrease/);
    assert.equal(after("-fpsmax"), "30");
    assert.equal(after("-protocol_whitelist"), "fd,pipe");
    assert.equal(after("-c:v"), "libsvtav1");
  });
});
