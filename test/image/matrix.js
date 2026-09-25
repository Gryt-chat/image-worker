"use strict";
// Runs inside the built image as the worker does, against /fixtures and the probe jail.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
