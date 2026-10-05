/* The desktop app's stand-in for the jail: a worker forked by the app sends uploads back to it
   over IPC, to be decoded in a sandboxed Chromium renderer (GRYT-1664, client#775). */
import type { Use } from "./reencode";
import type { JailResult } from "./reencodeResult";

const TIMEOUT_MS = 150_000;
// The app gives a chat video ten minutes, so this waits a little past that.
const CHAT_VIDEO_TIMEOUT_MS = 10 * 60_000 + 30_000;
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
const VIDEO_BOX = { banner: { width: 960, height: 492 }, avatar: { width: 256, height: 256 } } as const;

export type DesktopVideo = { video: Buffer; poster: Buffer; width: number; height: number };

export function hasDesktopSandbox(env = process.env, proc: Pick<NodeJS.Process, "send" | "connected"> = process): boolean {
  return env.GRYT_MEDIA_SANDBOX === "ipc" && typeof proc.send === "function" && proc.connected === true;
}

let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  process.on("message", (message: unknown) => {
    const m = message as { type?: unknown; id?: unknown; result?: unknown } | null;
    if (!m || m.type !== "gryt-media-result" || typeof m.id !== "number") return;
    const entry = waiting.get(m.id);
    if (!entry) return;
    waiting.delete(m.id);
    clearTimeout(entry.timer);
    entry.resolve(m.result);
  });
  process.on("disconnect", () => {
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error("The app closed the media sandbox"));
      waiting.delete(id);
    }
  });
}

function ask(kind: "image" | "video" | "poster" | "chatvideo", use: string, bytes: Buffer): Promise<unknown> {
  listen();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("The media sandbox ran out of time"));
    }, kind === "chatvideo" ? CHAT_VIDEO_TIMEOUT_MS : TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    process.send!({ type: "gryt-media-job", id, job: { kind, use, bytes } }, undefined, undefined, (err) => {
      if (!err) return;
      clearTimeout(timer);
      waiting.delete(id);
      reject(err);
    });
  });
}

const positive = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= max;
const bytesOf = (v: unknown): Buffer | null =>
  v instanceof Uint8Array && v.length > 0 && v.length <= MAX_ANSWER_BYTES ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null;
const isWebp = (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isMp4 = (b: Buffer) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp";

/* Read back as untrusted, like the jail's answer: the renderer is the process that touched the upload. */
export function checkImageAnswer(answer: unknown): JailResult {
  const a = (answer ?? {}) as Record<string, unknown>;
  if (a.ok !== true) throw new Error(typeof a.reason === "string" ? a.reason.slice(0, 200) : "The upload could not be decoded");
  const body = bytesOf(a.body);
  const thumb = a.thumb === null ? null : bytesOf(a.thumb);
  if (a.kind !== "image" || !body || !isWebp(body) || (a.thumb !== null && (!thumb || !isWebp(thumb)))
    || a.mime !== "image/webp" || !positive(a.width, 8192) || !positive(a.height, 8192)
    || typeof a.animated !== "boolean" || !(a.thumbPx === null || positive(a.thumbPx, 8192))
    || !(a.colour === null || (typeof a.colour === "string" && /^#[0-9a-f]{6}$/.test(a.colour)))) {
    throw new Error("Bad result from the media sandbox");
  }
  return {
    body, thumb, mime: "image/webp", ext: "webp", thumbMime: "image/webp",
    width: a.width, height: a.height, animated: a.animated,
    thumbPx: a.thumbPx as number | null, dominantColor: a.colour as string | null,
  };
}

export function checkVideoAnswer(answer: unknown, use: "banner" | "avatar"): DesktopVideo {
  const a = (answer ?? {}) as Record<string, unknown>;
  if (a.ok !== true) throw new Error(typeof a.reason === "string" ? a.reason.slice(0, 200) : "The video could not be decoded");
  const video = bytesOf(a.video);
  const poster = bytesOf(a.poster);
  const box = VIDEO_BOX[use];
  if (a.kind !== "video" || !video || !isMp4(video) || !poster || !isJpeg(poster)
    || a.width !== box.width || a.height !== box.height) {
    throw new Error("Bad result from the media sandbox");
  }
  return { video, poster, width: box.width, height: box.height };
}

/** A chat video's still: a JPEG no wider than the jail's 320px poster. */
export function checkPosterAnswer(answer: unknown): Buffer {
  const a = (answer ?? {}) as Record<string, unknown>;
  if (a.ok !== true) throw new Error(typeof a.reason === "string" ? a.reason.slice(0, 200) : "The video could not be decoded");
  const poster = bytesOf(a.poster);
  if (a.kind !== "poster" || !poster || !isJpeg(poster) || !positive(a.width, 320) || !positive(a.height, 4096)) {
    throw new Error("Bad result from the media sandbox");
  }
  return poster;
}

export async function posterOnDesktop(bytes: Buffer): Promise<Buffer> {
  return checkPosterAnswer(await ask("poster", "upload", bytes));
}

/** A chat video converted with its sound: an MP4 inside 1280px, and a JPEG poster. */
export function checkChatVideoAnswer(answer: unknown): DesktopVideo {
  const a = (answer ?? {}) as Record<string, unknown>;
  if (a.ok !== true) throw new Error(typeof a.reason === "string" ? a.reason.slice(0, 200) : "The video could not be decoded");
  const video = bytesOf(a.video);
  const poster = bytesOf(a.poster);
  if (a.kind !== "chatvideo" || !video || !isMp4(video) || !poster || !isJpeg(poster)
    || !positive(a.width, 1280) || !positive(a.height, 1280)) {
    throw new Error("Bad result from the media sandbox");
  }
  return { video, poster, width: a.width, height: a.height };
}

export async function chatVideoOnDesktop(bytes: Buffer): Promise<DesktopVideo> {
  return checkChatVideoAnswer(await ask("chatvideo", "upload", bytes));
}

export async function reencodeOnDesktop(bytes: Buffer, use: Use): Promise<JailResult> {
  return checkImageAnswer(await ask("image", use, bytes));
}

export async function transcodeOnDesktop(bytes: Buffer, use: "banner" | "avatar"): Promise<DesktopVideo> {
  return checkVideoAnswer(await ask("video", use, bytes), use);
}
