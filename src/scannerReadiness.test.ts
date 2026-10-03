import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeScanner } from "./malwareScan";

test("scanner readiness requires a bounded complete PONG response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gryt-ready-"));
  const socketPath = join(dir, "clamd.sock");
  let reply = "PONG\0";
  const server = createServer((socket) => {
    socket.on("data", (bytes) => {
      assert.equal(bytes.toString(), "zPING\0");
      if (reply !== "hang") socket.end(reply);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    assert.equal(await probeScanner(socketPath), true);
    for (const bad of ["PONG", "garbage\0", "x".repeat(65), "hang"]) {
      reply = bad;
      assert.equal(await probeScanner(socketPath, 50), false, bad);
    }
    assert.equal(await probeScanner(join(dir, "missing")), false);
    assert.equal(await probeScanner(""), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
