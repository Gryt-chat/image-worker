import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_VIDEO_SECONDS, transcodeArgs } from "./transcode";

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
