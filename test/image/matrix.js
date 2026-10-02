"use strict";
// Runs inside the built image as the worker does, against /fixtures and the probe jail.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sharp = require("/app/node_modules/sharp");
const { initStorage } = require("/app/dist/storage.js");
const vp = require("/app/dist/videoPoster.js");

const tools = vp.findFrameTools();
const at = (name) => path.join("/fixtures", name);
let failures = 0;

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`ok    ${name}${note ? `  (${note})` : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

const posters = [
  "h264-aac.mp4", "vp9-opus.webm", "vp8.webm", "hevc.mp4", "av1.mp4", "av1.webm",
  "h264.mkv", "h264.mov", "rotated.mp4", "short.mp4", "4k-h264.mp4", "4k-hevc.mp4", "head60k.mp4",
];
const refused = [
  "random.mp4", "text.mp4", "png.mp4", "cut40k.mp4", "clip.avi", "avi.mp4", "clip.flv", "mpeg4.mp4",
];

function runProbe(cmd, argv) {
  return new Promise((resolve, reject) => {
    const input = fs.openSync(at("h264-aac.mp4"), "r");
    const child = spawn(cmd, argv, { env: {}, stdio: ["ignore", "pipe", "pipe", input] });
    fs.closeSync(input);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`probe exited ${code}: ${err.trim()}`));
      const result = {};
      for (const line of out.trim().split("\n")) {
        const [name, yes, ...detail] = line.split(" ");
        result[name] = { yes: yes === "yes", detail: detail.join(" ") };
      }
      resolve(result);
    });
  });
}

async function main() {
  console.log(`tools: ${JSON.stringify(tools)}`);
  fs.writeFileSync("/data/gryt.db", "gryt-ff-canary database\n");

  await check("real ClamAV accepts clean media and detects EICAR", async () => {
    const { scanMedia, MalwareDetected } = require("/app/dist/malwareScan.js");
    const dir = fs.mkdtempSync("/data/clam-test-");
    const socket = path.join(dir, "clamd.sock");
    const config = path.join(dir, "clamd.conf");
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    fs.writeFileSync(path.join(dir, "test.hdb"), `${createHash("md5").update(eicar).digest("hex")}:${eicar.length}:Gryt.Eicar-Test\n`);
    fs.writeFileSync(config, `Foreground yes\nLocalSocket ${socket}\nDatabaseDirectory ${dir}\nTemporaryDirectory ${dir}\nStreamMaxLength 64M\nMaxFileSize 64M\nMaxScanSize 128M\nAlertExceedsMax yes\n`);
    const child = spawn("/usr/sbin/clamd", ["--config-file", config], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (bytes) => { log += bytes; });
    child.stderr.on("data", (bytes) => { log += bytes; });
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(socket) && Date.now() < deadline) {
        assert.equal(child.exitCode, null, log);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(fs.existsSync(socket), log);
      const clean = await sharp({ create: { width: 10, height: 10, channels: 3, background: "green" } }).png().toBuffer();
      await scanMedia(clean, socket);
      await assert.rejects(scanMedia(eicar, socket), (error) => error instanceof MalwareDetected && /Eicar/.test(error.signature));
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("reconstructs banners in the raster jail", async () => {
    const decoder = require("/app/dist/imageDecoder.js");
    const bytes = await sharp({ create: { width: 100, height: 70, channels: 3, background: "red" } }).png().toBuffer();
    const result = await decoder.reconstructUploadedImage(bytes, 1048576, true);
    assert.equal((await sharp(result.body).metadata()).width, 960);
    assert.notDeepEqual(result.body, bytes);
    await assert.rejects(decoder.reconstructUploadedImage(Buffer.from("invalid"), 1048576, true));
  });
  await check("reconstructs avatar and emoji profiles in the raster jail", async () => {
    const decoder = require("/app/dist/imageDecoder.js");
    const bytes = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).png().toBuffer();
    const transform = { width: 256, height: 256, thumbWidth: 128, thumbHeight: 128, maxFrames: 480, fit: "cover" };
    const avatar = await decoder.reconstructUploadedImage(bytes, 1048576, false, 320, undefined, transform);
    assert.equal(avatar.mime, "image/avif");
    assert.equal(avatar.width, 256);
    assert.equal(avatar.height, 256);
    assert.equal((await sharp(avatar.thumb).metadata()).width, 128);
    const emoji = await decoder.reconstructUploadedImage(bytes, 1048576, false, 320, undefined,
      { ...transform, width: 128, height: 128, fit: "inside" });
    assert.equal(emoji.width, 80);
    assert.equal(emoji.height, 40);
  });
  await check("raster jail blocks storage, credentials, network and subprocesses", async () => {
    const script = `const fs=require("fs");const net=require("net");const cp=require("child_process");
      let storage=false,network=false,processes=false;
      try{fs.readFileSync("/data/gryt.db");}catch(e){storage=e.code==="ENOENT";}
      try{net.createConnection({host:"127.0.0.1",port:80}).on("error",e=>{network=e.code==="EPERM";done();});}catch(e){network=e.code==="EPERM";}
      const p=cp.spawnSync("/usr/local/bin/node",["-e","0"]);processes=!!p.error;
      function done(){console.log(JSON.stringify({storage,network,processes,secret:process.env.S3_SECRET_ACCESS_KEY||null}));}`;
    const result = await vp.runDecoder("/usr/local/bin/ffjail", ["run", process.env.IMAGEJAIL_SOCKET, String(16 * 1024 * 1024 * 1024), "5000", "--", "--jitless", "--disable-wasm-trap-handler", "-e", script], at("h264-aac.mp4"), 6000);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { storage: true, network: true, processes: true, secret: null });
  });

  for (const name of posters) {
    await check(`poster from ${name}`, async () => {
      const started = Date.now();
      const grabbed = await vp.grabFrame(at(name), tools);
      assert.ok(grabbed.ok, grabbed.ok ? "" : grabbed.reason);
      const meta = await sharp(await vp.posterFromFrame(grabbed.frame)).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, 320);
      return `${meta.width}x${meta.height}, ${Date.now() - started} ms`;
    });
  }

  for (const name of refused) {
    await check(`refuses ${name}`, async () => {
      const grabbed = await vp.grabFrame(at(name), tools);
      assert.equal(grabbed.ok, false);
      assert.equal(grabbed.refused, true, grabbed.reason);
      return grabbed.reason;
    });
  }

  await check("kills ffmpeg at the time cap", async () => {
    const grabbed = await vp.grabFrame(at("4k-hevc.mp4"), tools, { timeoutMs: 1 });
    assert.deepEqual(grabbed, { ok: false, refused: true, reason: "ffmpeg ran past 1ms" });
  });

  await check("stops ffmpeg at the memory cap", async () => {
    const grabbed = await vp.grabFrame(at("4k-h264.mp4"), tools, { memoryBytes: 32 * 1024 * 1024 });
    assert.equal(grabbed.ok, false);
    return grabbed.reason;
  });

  await check("stores a poster through filesystem storage and leaves no temp files", async () => {
    fs.mkdirSync("/data/gryt/uploads", { recursive: true });
    fs.copyFileSync(at("h264-aac.mp4"), "/data/gryt/uploads/v.mp4");
    await initStorage();
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("gryt-poster-")).length;
    const result = await vp.processUploadedVideo("gryt", "v", "uploads/v.mp4", tools);
    assert.deepEqual(result, { thumbKey: "thumbnails/v.jpg", refused: false, reason: null });
    assert.ok(fs.existsSync("/data/gryt/thumbnails/v.jpg"));
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("gryt-poster-")).length;
    assert.equal(after, before);
  });

  for (const area of ["banners", "uploads"]) {
    await check(`decodes quarantined ${area} videos through the jail`, async () => {
      const key = `quarantine/${area}/video.mp4`;
      fs.mkdirSync(`/data/gryt/quarantine/${area}`, { recursive: true });
      fs.copyFileSync(at("h264-aac.mp4"), `/data/gryt/${key}`);
      const result = await vp.processUploadedVideo("gryt", `quarantined-${area}`, key, tools);
      assert.equal(result.refused, false, result.reason);
      assert.equal(result.thumbKey, `thumbnails/quarantined-${area}.jpg`);
      assert.equal((await sharp(`/data/gryt/${result.thumbKey}`).metadata()).format, "jpeg");
    });
    await check(`rejects malformed quarantined ${area} videos`, async () => {
      const key = `quarantine/${area}/bad.mp4`;
      fs.copyFileSync(at("random.mp4"), `/data/gryt/${key}`);
      const result = await vp.processUploadedVideo("gryt", `bad-${area}`, key, tools);
      assert.equal(result.refused, true);
      assert.equal(result.thumbKey, null);
      assert.equal(fs.existsSync(`/data/gryt/thumbnails/bad-${area}.jpg`), false);
    });
  }

  if (!tools.jail) {
    console.log("no jail in this image, so the isolation checks are skipped");
  } else {
    await isolation();
  }

  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
}

async function isolation() {
  await check("ffmpeg runs as gryt-ff with no new privileges and a seccomp filter", async () => {
    let settled = false;
    const pending = vp.grabFrame(at("4k-hevc.mp4"), tools).finally(() => (settled = true));
    let status = null;
    while (!status && !settled) {
      for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
        try {
          if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "ffmpeg") {
            status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
          }
        } catch {
          /* it exited between the listing and the read */
        }
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    await pending;
    assert.ok(status, "never saw an ffmpeg process");
    const field = (name) => status.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))[1].trim();
    assert.match(field("Uid"), /^1002\s+1002\s+1002\s+1002$/);
    assert.match(field("Gid"), /^1002\s+1002\s+1002\s+1002$/);
    assert.equal(field("Groups"), "");
    assert.equal(field("NoNewPrivs"), "1");
    assert.equal(field("Seccomp"), "2");
    assert.equal(field("CapEff"), "0000000000000000");
    return `Uid ${field("Uid").split(/\s+/)[0]}, Seccomp ${field("Seccomp")}`;
  });

  // The control: the same probe outside the jail, as the worker's own user, finds everything.
  const outside = await runProbe("/opt/gryt-ff/probe", []);
  await check("control: outside the jail the probe reads the worker's secrets", async () => {
    assert.ok(outside.read_worker_environ.yes && outside.read_worker_environ.detail === "canary");
    assert.ok(outside.read_database.yes && outside.read_database.detail === "canary");
    assert.ok(outside.socket_inet.yes);
    return "environ, database and a socket were all reachable";
  });

  const memory = 256 * 1024 * 1024;
  const inside = await runProbe(tools.jail.client, [
    "run", "/run/gryt-ff/probe.sock", String(memory), "5000", "--", "-probe",
  ]);
  const blocked = [
    "own_env", "capabilities", "read_worker_environ", "read_own_environ", "read_database", "list_storage",
    "read_app", "read_passwd", "list_root", "escape_chroot", "create_file", "socket_inet", "socket_unix",
    "socketpair", "signal_worker", "ptrace_worker", "read_worker_memory", "fork", "write_input",
  ];
  for (const name of blocked) {
    await check(`in the jail, ${name} fails`, async () => {
      assert.ok(inside[name], "the probe didn't report it");
      assert.equal(inside[name].yes, false, inside[name].detail);
      return inside[name].detail;
    });
  }
  await check("in the jail, the probe still reads its input and writes its output", async () => {
    assert.equal(inside.read_input.yes, true);
  });
  await check("in the jail, the probe is gryt-ff with no groups, no new privileges and the memory cap", async () => {
    assert.equal(inside.uid.detail, "1002");
    assert.equal(inside.groups.detail, "0");
    assert.equal(inside.no_new_privs.detail, "1");
    assert.equal(inside.rlimit_as.detail, String(memory));
  });
}

setTimeout(() => {
  console.log("FAIL  the matrix ran past five minutes");
  process.exit(1);
}, 300_000).unref();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
