/* Banner and avatar videos are never served as sent: ffmpeg in the jail draws every frame into one
   fixed size and rate, drops sound, cuts at ten seconds and writes AV1 in MP4 (GRYT-1664). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { CODEC_WHITELIST, FORMAT_WHITELIST, type FrameTools, frameCommand, grabFrame, JAIL_FAILED, posterFromFrame, run } from "./videoPoster";

export type VideoUse = "banner" | "avatar";

const BOX: Record<VideoUse, { width: number; height: number }> = {
  banner: { width: 960, height: 492 },
  avatar: { width: 256, height: 256 },
};

export const MAX_VIDEO_SECONDS = 10;
const FPS = 24;
const TRANSCODE_TIMEOUT_MS = 120_000;
const TRANSCODE_MEMORY_BYTES = 1536 * 1024 * 1024;

/* Fragmented MP4, since the output is a pipe and a plain MP4 needs to seek back to write its index.
   Scale-then-crop runs per frame, so a stream that changes size mid-way still comes out one size. */
export function transcodeArgs(use: VideoUse): string[] {
  const { width, height } = BOX[use];
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-filter_threads", "1",
    "-protocol_whitelist", "fd,pipe",
    "-format_whitelist", FORMAT_WHITELIST,
    "-codec_whitelist", `${CODEC_WHITELIST},libsvtav1,png`,
    "-fd", "3", "-i", "fd:",
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-t", String(MAX_VIDEO_SECONDS),
    "-vf", `fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1,format=yuv420p`,
    "-c:v", "libsvtav1", "-preset", "8", "-crf", "42", "-g", String(FPS * MAX_VIDEO_SECONDS), "-svtav1-params", "lp=2",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
}

/** The server's "Video uploads" setting; the server keeps the same list in settings/chatVideoMode.ts. */
export type ChatVideoMode = "original" | "balanced" | "small";

const CHAT_ENCODE: Record<ChatVideoMode, { side: number; fps: number; crf: number; audioKbps: number }> = {
  original: { side: 2560, fps: 60, crf: 30, audioKbps: 192 },
  balanced: { side: 1920, fps: 60, crf: 32, audioKbps: 160 },
  small: { side: 1280, fps: 30, crf: 38, audioKbps: 128 },
};

export const CHAT_VIDEO_MAX_SIDE = CHAT_ENCODE.small.side;
export const CHAT_AUDIO_DECODERS = "aac,mp3,mp3float,opus,vorbis,flac,pcm_s16le,pcm_f32le";
const CHAT_TRANSCODE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Codecs every browser and phone Gryt runs on can play from an MP4, so "original" copies them. */
const REMUX_VIDEO = new Set(["h264", "vp9", "av1"]);
const REMUX_AUDIO = new Set(["aac", "mp3"]);

const INPUT = (logLevel: string, decoders: string): string[] => [
  "-nostdin", "-hide_banner", "-loglevel", logLevel,
  "-protocol_whitelist", "fd,pipe",
  "-format_whitelist", FORMAT_WHITELIST,
  "-codec_whitelist", decoders,
  "-fd", "3", "-i", "fd:",
];
const STRIP = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"];
const FRAGMENTED_MP4 = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"];

/* Every frame scaled into the box, so a stream that changes size comes out one size; the
   first audio track, if there is one, as stereo AAC. Nothing else from the upload is kept. */
export function chatTranscodeArgs(mode: ChatVideoMode = "small"): string[] {
  const { side, fps, crf, audioKbps } = CHAT_ENCODE[mode];
  return [
    "-filter_threads", "1",
    ...INPUT("error", `${CODEC_WHITELIST},${CHAT_AUDIO_DECODERS},libsvtav1,aac`),
    ...STRIP,
    "-vf", `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p`,
    "-fpsmax", String(fps),
    "-c:v", "libsvtav1", "-preset", "10", "-crf", String(crf), "-g", "240", "-svtav1-params", "lp=2",
    "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2", "-ar", "48000",
    ...FRAGMENTED_MP4,
  ];
}

/** Decodes the first second, which proves the streams open, and prints which codecs they are. */
export function chatProbeArgs(): string[] {
  return [
    ...INPUT("info", `${CODEC_WHITELIST},${CHAT_AUDIO_DECODERS}`),
    "-map", "0:v:0", "-map", "0:a:0?", "-t", "1", "-f", "null", "-",
  ];
}

/** Reads ffmpeg's "Stream mapping" lines: output 0 is the video map, output 1 the audio. */
export function parseProbe(stderr: string): { video: string | null; audio: string | null } {
  const found: Record<string, string> = {};
  for (const m of stderr.matchAll(/Stream #0:\d+ -> #0:(\d+) \((\w+) \(/g)) found[m[1]] = m[2];
  return { video: found["0"] ?? null, audio: found["1"] ?? null };
}

/** The video stream as it was uploaded, in a new MP4, with metadata, chapters and extra tracks gone. */
export function chatRemuxArgs(audio: string | null): string[] {
  const audioArgs = audio === null || REMUX_AUDIO.has(audio)
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", `${CHAT_ENCODE.original.audioKbps}k`, "-ac", "2", "-ar", "48000"];
  return [
    ...INPUT("error", `${CODEC_WHITELIST},${CHAT_AUDIO_DECODERS},aac`),
    ...STRIP, "-c:v", "copy", ...audioArgs, ...FRAGMENTED_MP4,
  ];
}

export function canRemux(video: string | null): boolean {
  return video !== null && REMUX_VIDEO.has(video);
}

export type ChatTranscodeResult =
  | { ok: true; video: Buffer; poster: Buffer; width: number; height: number }
  | { ok: false; refused: boolean; reason: string };

export async function transcodeChatVideo(
  inputPath: string,
  tools: FrameTools,
  mode: ChatVideoMode = "small",
  maxOutputBytes?: number,
): Promise<ChatTranscodeResult> {
  let args = chatTranscodeArgs(mode);
  if (mode === "original") {
    const probe = frameCommand(tools, chatProbeArgs(), process.platform, TRANSCODE_MEMORY_BYTES, PROBE_TIMEOUT_MS);
    if ("missing" in probe) return { ok: false, refused: false, reason: probe.missing };
    const probed = await run(probe.cmd, probe.argv, inputPath, PROBE_TIMEOUT_MS);
    if (tools.jail && probed.code === JAIL_FAILED) return { ok: false, refused: false, reason: "the ffmpeg jail could not start" };
    if (probed.timedOut || probed.code !== 0) return { ok: false, refused: true, reason: "the video could not be decoded" };
    const { video, audio } = parseProbe(probed.stderr);
    if (canRemux(video)) args = chatRemuxArgs(audio);
  }

  const command = frameCommand(tools, args, process.platform, TRANSCODE_MEMORY_BYTES, CHAT_TRANSCODE_TIMEOUT_MS);
  if ("missing" in command) return { ok: false, refused: false, reason: command.missing };

  const result = await run(command.cmd, command.argv, inputPath, CHAT_TRANSCODE_TIMEOUT_MS, maxOutputBytes);
  if (result.timedOut) return { ok: false, refused: true, reason: "the transcode ran out of time" };
  if (result.tooBig) return { ok: false, refused: true, reason: "the transcode came out over the size cap" };
  if (tools.jail && result.code === JAIL_FAILED) return { ok: false, refused: false, reason: "the ffmpeg jail could not start" };
  if (result.code !== 0 || result.stdout.length === 0) return { ok: false, refused: true, reason: "the video could not be decoded" };

  const dir = await mkdtemp(join(tmpdir(), "gryt-chat-transcoded-"));
  try {
    const written = join(dir, "video.mp4");
    await writeFile(written, result.stdout, { mode: 0o600, flag: "wx" });
    const frame = await grabFrame(written, tools);
    if (!frame.ok) return { ok: false, refused: true, reason: `no poster from the transcode: ${frame.reason}` };
    const { width, height } = await sharp(frame.frame).metadata();
    if (!width || !height) return { ok: false, refused: true, reason: "the transcode has no picture size" };
    return { ok: true, video: result.stdout, poster: await posterFromFrame(frame.frame), width, height };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type TranscodeResult =
  | { ok: true; video: Buffer; poster: Buffer; width: number; height: number }
  | { ok: false; refused: boolean; reason: string };

export async function transcodeVideo(inputPath: string, use: VideoUse, tools: FrameTools): Promise<TranscodeResult> {
  const command = frameCommand(tools, transcodeArgs(use), process.platform, TRANSCODE_MEMORY_BYTES, TRANSCODE_TIMEOUT_MS);
  if ("missing" in command) return { ok: false, refused: false, reason: command.missing };

  const result = await run(command.cmd, command.argv, inputPath, TRANSCODE_TIMEOUT_MS);
  if (result.timedOut) return { ok: false, refused: true, reason: "the transcode ran out of time" };
  if (result.tooBig) return { ok: false, refused: true, reason: "the transcode came out over the size cap" };
  if (tools.jail && result.code === JAIL_FAILED) return { ok: false, refused: false, reason: "the ffmpeg jail could not start" };
  if (result.code !== 0 || result.stdout.length === 0) return { ok: false, refused: true, reason: "the video could not be decoded" };

  // The poster comes from what we wrote, not from the upload.
  const dir = await mkdtemp(join(tmpdir(), "gryt-transcoded-"));
  try {
    const written = join(dir, "video.mp4");
    await writeFile(written, result.stdout, { mode: 0o600, flag: "wx" });
    const frame = await grabFrame(written, tools);
    if (!frame.ok) return { ok: false, refused: true, reason: `no poster from the transcode: ${frame.reason}` };
    return { ok: true, video: result.stdout, poster: await posterFromFrame(frame.frame), ...BOX[use] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
