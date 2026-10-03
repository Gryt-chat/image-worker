import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerImage = process.env.WORKER_IMAGE ?? "gryt-ff-worker";
let scannerImage = process.env.SCANNER_IMAGE;
const name = `gryt-scanner-test-${randomUUID()}`;
const dir = mkdtempSync(join(tmpdir(), "gryt-scanner-deploy-"));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
let started = false;
try {
  const deployment = JSON.parse(execFileSync("docker", ["compose", "-f", "examples/scanner/compose.yml", "config", "--format", "json"], {
    encoding: "utf8", env: { ...process.env, GRYT_IMAGE_WORKER_IMAGE: workerImage, GRYT_MEDIA_VOLUME: name, GRYT_MEDIA_BUCKET: "test" },
  }));
  scannerImage ??= deployment.services.clamav.image;
  assert.equal(deployment.services.clamav.ports, undefined);
  assert.equal(deployment.services["image-worker"].environment.CLAMD_REQUIRED, "1");
  assert.equal(deployment.volumes["media-data"].external, true);
  assert.ok(deployment.services["image-worker"].volumes.some((volume) => volume.target === "/run/gryt-clam" && volume.read_only));
  assert.deepEqual(deployment.services.clamav.volumes.filter((volume) => volume.type === "volume").map((volume) => volume.target).sort(), ["/tmp", "/var/lib/clamav"]);
  assert.ok(Object.keys(deployment.services.clamav.environment).every((key) => ["TZ", "FRESHCLAM_CHECKS"].includes(key)));
  const config = readFileSync("examples/scanner/clamd.conf", "utf8");
  assert.ok(!/^TCPSocket\s/m.test(config));
  assert.match(config, /^AlertExceedsMax yes$/m);
  writeFileSync(join(dir, "clamd.conf"), config);
  mkdirSync(join(dir, "signatures"));
  mkdirSync(join(dir, "run"));
  chmodSync(dir, 0o755);
  chmodSync(join(dir, "run"), 0o1777);
  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
  writeFileSync(join(dir, "signatures/test.hdb"), `${createHash("md5").update(eicar).digest("hex")}:${eicar.length}:Gryt.Eicar-Test\n`);
  docker("run", "--detach", "--name", name, "--platform", "linux/amd64", "--network", "none",
    "--memory", "4g", "--pids-limit", "64", "--cpus", "2", "--security-opt", "no-new-privileges:true",
    "--mount", `type=bind,source=${dir}/signatures,target=/var/lib/clamav,readonly`,
    "--mount", `type=bind,source=${dir}/run,target=/tmp`,
    "--mount", `type=bind,source=${dir}/clamd.conf,target=/etc/clamav/clamd.conf,readonly`,
    "--entrypoint", "clamd", scannerImage, "--foreground", "--config-file=/etc/clamav/clamd.conf");
  started = true;
  let ready = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      docker("exec", name, "clamdscan", "--config-file=/etc/clamav/clamd.conf", "--ping=1");
      ready = true;
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, docker("logs", name));
  const check = `const assert=require('node:assert/strict');const {scanMedia,probeScanner,MalwareDetected}=require('/app/dist/malwareScan');
    (async()=>{const socket='/run/gryt-clam/clamd.sock';assert.equal(await probeScanner(socket),true);
    await scanMedia(Buffer.from('clean fixture'),socket);
    await assert.rejects(scanMedia(Buffer.from(${JSON.stringify(eicar)}),socket),e=>e instanceof MalwareDetected&&/Eicar/.test(e.signature));
    console.log('official scanner socket, health, clean and EICAR checks passed');})().catch(e=>{console.error(e);process.exitCode=1;});`;
  process.stdout.write(docker("run", "--rm", "--network", "none", "--user", "1001:1001",
    "--mount", `type=bind,source=${dir}/run,target=/run/gryt-clam,readonly`, "--entrypoint", "node", workerImage, "-e", check));
} finally {
  if (started) docker("rm", "--force", name);
  rmSync(dir, { recursive: true, force: true });
}
