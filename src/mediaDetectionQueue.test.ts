import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("only scanner detections produce private audit events; no media is approved on scanner failure", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "gryt-detection-"));
  const socketPath = join(dir, "clamd.sock");
  const scanner = createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 14) return;
      const size = input.readUInt32BE(10);
      if (input.length < 18 + size) return;
      const bytes = input.subarray(14, 14 + size);
      socket.end(bytes.toString() === "detected" ? "stream: Eicar-Signature FOUND\0" : "stream: scan failed ERROR\0");
    });
  });
  await new Promise<void>((resolve, reject) => { scanner.once("error", reject); scanner.listen(socketPath, resolve); });
  const db = new DatabaseSync(join(dir, "gryt.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE files (file_id TEXT PRIMARY KEY, s3_key TEXT, mime TEXT, size INTEGER, thumbnail_key TEXT, dominant_color TEXT, thumbnail_px INTEGER, created_at TEXT, uploaded_by_server_user_id TEXT);
    CREATE TABLE image_jobs (job_id TEXT PRIMARY KEY, file_id TEXT, status TEXT, raw_s3_key TEXT, raw_content_type TEXT, raw_bytes INTEGER, error_message TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE server_config (id TEXT PRIMARY KEY, upload_max_bytes INTEGER, avatar_thumb_px INTEGER);
    CREATE TABLE audit_log (event_id TEXT PRIMARY KEY, actor_server_user_id TEXT, action TEXT, target TEXT, meta_json TEXT, created_at TEXT);
    INSERT INTO server_config VALUES ('config', 1048576, NULL);`);
  await mkdir(join(dir, "test/quarantine/uploads"), { recursive: true });
  for (const id of ["detected", "scanner-error"]) {
    const key = `quarantine/uploads/${id}`;
    await writeFile(join(dir, "test", key), id);
    db.prepare("INSERT INTO files VALUES (?, ?, 'image/png', ?, NULL, NULL, NULL, ?, 'member-1')").run(id, key, id.length, new Date().toISOString());
    db.prepare("INSERT INTO image_jobs VALUES (?, ?, 'queued', ?, 'image/png', ?, NULL, ?, ?)").run(id, id, key, id.length, new Date().toISOString(), new Date().toISOString());
  }
  const child = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, CLAMD_SOCKET: socketPath, DATA_DIR: dir, STORAGE_BACKEND: "filesystem", S3_BUCKET: "test", HEALTH_PORT: "18083", IMAGE_WORKER_POLL_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (bytes) => { log += bytes; });
  child.stderr.on("data", (bytes) => { log += bytes; });
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM image_jobs WHERE status IN ('queued', 'processing')").get() as { n: number };
      if (!pending.n) break;
      assert.equal(child.exitCode, null, log);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const jobs = db.prepare("SELECT status FROM image_jobs").all();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.status === "error"), log);
    const records = db.prepare("SELECT * FROM audit_log").all();
    assert.equal(records.length, 1, log);
    assert.equal(records[0].actor_server_user_id, null);
    assert.equal(records[0].action, "media.scan_detection");
    assert.equal(records[0].target, "detected");
    const meta = JSON.parse(records[0].meta_json as string);
    assert.equal(meta.uploader, "member-1");
    assert.equal(meta.signature, "Eicar-Signature");
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    db.prepare("UPDATE image_jobs SET status = 'queued' WHERE job_id = 'detected'").run();
    const retryDeadline = Date.now() + 2000;
    while (Date.now() < retryDeadline) {
      const job = db.prepare("SELECT status FROM image_jobs WHERE job_id = 'detected'").get();
      if (job?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.n, 1);
    assert.equal(db.prepare("SELECT status FROM image_jobs WHERE job_id = 'detected'").get()?.status, "error");
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    await new Promise<void>((resolve) => scanner.close(() => resolve()));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
