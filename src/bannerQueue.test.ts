import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import sharp from "sharp";

test("the worker approves re-encoded banners and rejects bad media without ffmpeg", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "gryt-banner-queue-"));
  const db = new DatabaseSync(join(dir, "gryt.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE files (file_id TEXT PRIMARY KEY, s3_key TEXT, mime TEXT, size INTEGER, thumbnail_key TEXT, dominant_color TEXT, thumbnail_px INTEGER, created_at TEXT, width INTEGER, height INTEGER);
    CREATE TABLE image_jobs (job_id TEXT PRIMARY KEY, file_id TEXT, status TEXT, raw_s3_key TEXT, raw_content_type TEXT, raw_bytes INTEGER, error_message TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE server_config (id TEXT PRIMARY KEY, upload_max_bytes INTEGER, avatar_thumb_px INTEGER);
    INSERT INTO server_config VALUES ('config', 1048576, NULL);`);
  await mkdir(join(dir, "test/quarantine/banners"), { recursive: true });
  await mkdir(join(dir, "test/quarantine/uploads"), { recursive: true });
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  for (const [id, bytes, type] of [["valid", png, "image/png"], ["bad-image", Buffer.from("fake image"), "image/png"], ["no-decoder", Buffer.from("fake video"), "video/mp4"], ["chat-picture", png, "image/png"], ["chat-video", Buffer.from("fake video"), "video/mp4"]] as const) {
    const key = `quarantine/${id.startsWith("chat-") ? "uploads" : "banners"}/${id}`;
    await writeFile(join(dir, "test", key), bytes);
    db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)").run(id, key, type, bytes.length, new Date().toISOString());
    db.prepare("INSERT INTO image_jobs VALUES (?, ?, 'queued', ?, ?, ?, NULL, ?, ?)").run(id, id, key, type, bytes.length, new Date().toISOString(), new Date().toISOString());
  }
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PATH: "", FFJAIL_SOCKET: "", DATA_DIR: dir, STORAGE_BACKEND: "filesystem", S3_BUCKET: "test", HEALTH_PORT: "8080", IMAGE_WORKER_POLL_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM image_jobs WHERE status IN ('queued', 'processing')").get() as { n: number };
      if (!pending.n) break;
      assert.equal(child.exitCode, null, log);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = (id: string) => (db.prepare("SELECT status FROM image_jobs WHERE job_id = ?").get(id) as { status: string }).status;
    assert.equal(status("valid"), "done", log);
    assert.equal(status("bad-image"), "error", log);
    assert.equal(status("no-decoder"), "error", log);
    assert.equal(status("chat-picture"), "done", log);
    assert.equal(status("chat-video"), "error", log);
    const stored = db.prepare("SELECT s3_key FROM files WHERE file_id = 'valid'").get() as { s3_key: string };
    assert.equal(stored.s3_key, "banners/verified/valid.webp");
    assert.deepEqual({ ...db.prepare("SELECT width, height FROM files WHERE file_id = 'valid'").get() }, { width: 960, height: 384 });
    assert.equal((await sharp(await readFile(join(dir, "test", stored.s3_key))).metadata()).width, 960);
    await assert.rejects(readFile(join(dir, "test/quarantine/banners/valid")), { code: "ENOENT" });
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
