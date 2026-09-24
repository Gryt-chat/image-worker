import { spawn } from "child_process";
import { accessSync, constants } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import sharp from "sharp";

import { getObjectToFile, putObject } from "./storage";

/** The only demuxers, decoders and protocol ffmpeg may open. AV1 is `libdav1d`:
    the decoder named `av1` only drives hardware. */
export const FORMAT_WHITELIST = "mov,mp4,matroska,webm";
export const CODEC_WHITELIST = "h264,hevc,vp8,vp9,libdav1d";

/** Per attempt, and there are at most two: at one second, then at the start. */
export const FFMPEG_TIMEOUT_MS = 15_000;
/** Address space, not resident memory, so it has headroom for mapped libraries. */
export const FFMPEG_MEMORY_BYTES = 1024 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const POSTER_WIDTH = 320;

export interface FrameTools {
  ffmpeg: string | null;
  prlimit: string | null;
}

export type FrameResult =
  | { ok: true; frame: Buffer }
  | { ok: false; refused: boolean; reason: string };

export function findExecutable(name: string, pathEnv = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not in this directory */
    }
  }
  return null;
}

export function findFrameTools(pathEnv?: string): FrameTools {
  return { ffmpeg: findExecutable("ffmpeg", pathEnv), prlimit: findExecutable("prlimit", pathEnv) };
}

/** Everything before `-i` confines the input side; the output is one PNG on stdout.
    One thread on each side: every extra thread reserves its own malloc arena under the cap. */
export function ffmpegArgs(inputPath: string, seekSeconds: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-filter_threads", "1",
    "-protocol_whitelist", "file",
    "-format_whitelist", FORMAT_WHITELIST,
    "-codec_whitelist", CODEC_WHITELIST,
    "-threads", "1",
    "-ss", String(seekSeconds),
    "-i", `file:${inputPath}`,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-frames:v", "1",
    "-threads", "1",
    "-f", "image2pipe", "-c:v", "png",
    "pipe:1",
  ];
}

/** Without prlimit there is no memory cap. Linux is where the worker runs for
    real, so there it means no poster; elsewhere it is a dev machine. */
export function frameCommand(
  tools: FrameTools,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  memoryBytes = FFMPEG_MEMORY_BYTES,
): { cmd: string; argv: string[] } | { missing: string } {
  if (!tools.ffmpeg) return { missing: "ffmpeg is not installed" };
  if (tools.prlimit) {
    return { cmd: tools.prlimit, argv: [`--as=${memoryBytes}`, "--", tools.ffmpeg, ...args] };
  }
  if (platform === "linux") return { missing: "prlimit is not installed, so ffmpeg would have no memory cap" };
  return { cmd: tools.ffmpeg, argv: args };
}

/** The first lines, which name the cause; the last ones only say opening failed.
    Printable and without our temp path, since stderr describes a stranger's file. */
function describeFailure(stderr: string, inputPath: string): string {
  const lines = stderr
    .split(inputPath).join("<input>")
    .replace(/[^\x20-\x7e\n]/g, "?")
    .split("\n")
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim())
    .filter((l) => l && !l.startsWith("Last message repeated"));
  return [...new Set(lines)].slice(0, 2).join(" / ").slice(0, 300) || "ffmpeg failed without saying why";
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  tooBig: boolean;
}

function run(cmd: string, argv: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // No shell, and an empty environment so the S3 credentials stay with us.
    const child = spawn(cmd, argv, { cwd: tmpdir(), env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    let tooBig = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        tooBig = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("latin1")).slice(-4096);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut, tooBig });
    });
  });
}

/** Seeks to one second, and to the start when that finds nothing: a clip shorter
    than a second exits cleanly with no frame. */
export async function grabFrame(
  inputPath: string,
  tools: FrameTools,
  { timeoutMs = FFMPEG_TIMEOUT_MS, memoryBytes = FFMPEG_MEMORY_BYTES } = {},
): Promise<FrameResult> {
  for (const seek of [1, 0]) {
    const command = frameCommand(tools, ffmpegArgs(inputPath, seek), process.platform, memoryBytes);
    if ("missing" in command) return { ok: false, refused: false, reason: command.missing };

    let result: RunResult;
    try {
      result = await run(command.cmd, command.argv, timeoutMs);
    } catch (err) {
      return { ok: false, refused: false, reason: `could not start ffmpeg: ${(err as Error).message}` };
    }

    if (result.timedOut) return { ok: false, refused: true, reason: `ffmpeg ran past ${timeoutMs}ms` };
    if (result.tooBig) return { ok: false, refused: true, reason: "ffmpeg's frame was over the size cap" };
    if (result.code !== 0) {
      return { ok: false, refused: true, reason: describeFailure(result.stderr, inputPath) };
    }
    if (result.stdout.length > 0) return { ok: true, frame: result.stdout };
  }
  return { ok: false, refused: true, reason: "no video frame could be decoded" };
}

/** Re-encoded by sharp, so what is stored is a JPEG we made rather than ffmpeg's bytes. */
export async function posterFromFrame(frame: Buffer): Promise<Buffer> {
  return sharp(frame, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .resize({ width: POSTER_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export interface PosterResult {
  thumbKey: string | null;
  refused: boolean;
  reason: string | null;
}

export async function processUploadedVideo(
  bucket: string,
  fileId: string,
  rawKey: string,
  tools: FrameTools,
): Promise<PosterResult> {
  // Checked before the download: without the tools there is nothing to fetch it for.
  const usable = frameCommand(tools, []);
  if ("missing" in usable) return { thumbKey: null, refused: false, reason: usable.missing };

  const dir = await mkdtemp(join(tmpdir(), "gryt-poster-"));
  try {
    const inputPath = join(dir, "input");
    await getObjectToFile(bucket, rawKey, inputPath);

    const grabbed = await grabFrame(inputPath, tools);
    if (!grabbed.ok) return { thumbKey: null, refused: grabbed.refused, reason: grabbed.reason };

    const poster = await posterFromFrame(grabbed.frame);
    // The key and type the server's own ffmpeg call used, so nothing reading them changes.
    const thumbKey = `thumbnails/${fileId}.jpg`;
    await putObject(bucket, thumbKey, poster, "image/jpeg");
    return { thumbKey, refused: false, reason: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
