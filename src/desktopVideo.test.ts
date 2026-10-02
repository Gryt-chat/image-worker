import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { desktopVideoFrame } from "./desktopVideo";

test("desktop decoding requires the parent IPC channel", async () => {
  await assert.rejects(desktopVideoFrame("unused"), /unavailable/);
});

test("desktop decoder exchanges bounded bytes and rejects malformed replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gryt-desktop-video-"));
  const file = join(dir, "input");
  await writeFile(file, "video fixture");
  const source = `const { desktopVideoFrame } = require('./src/desktopVideo');
    const { findFrameTools } = require('./src/videoPoster');
    if (!findFrameTools('').desktop) throw new Error('No desktop capability');
    desktopVideoFrame(process.env.TEST_VIDEO).then(
      frame => { process.send({ type: 'test', frame: frame.toString() }); process.disconnect(); },
      error => { process.send({ type: 'test', error: error.message }); process.disconnect(); });`;
  try {
    for (const [frame, expected] of [[Buffer.from("frame fixture").toString("base64"), "frame fixture"], ["invalid!", "Invalid desktop video frame"]]) {
      const result = await new Promise<{ frame?: string; error?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["-r", "ts-node/register", "-e", source], {
          cwd: join(__dirname, ".."), env: { TEST_VIDEO: file, GRYT_VIDEO_DECODER: "electron-sandbox" },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let outcome: { frame?: string; error?: string } | undefined;
        let stderr = "";
        child.stderr!.on("data", (data) => { stderr += data; });
        child.on("message", (message: { type?: string; id?: string; input?: string; frame?: string; error?: string }) => {
          if (message.type === "gryt:video-frame") {
            assert.equal(Buffer.from(message.input!, "base64").toString(), "video fixture");
            child.send({ type: "gryt:video-frame-result", id: message.id, frame });
          } else if (message.type === "test") outcome = message;
        });
        child.once("error", reject);
        child.once("exit", (code) => { if (code !== 0 || !outcome) reject(new Error(stderr)); else resolve(outcome); });
      });
      assert.equal(result.frame ?? result.error, expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
