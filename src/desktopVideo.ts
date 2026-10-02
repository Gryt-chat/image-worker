import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export async function desktopVideoFrame(inputPath: string): Promise<Buffer> {
  if (!process.connected || !process.send) throw new Error("Desktop decoder is unavailable");
  if ((await stat(inputPath)).size > 64 * 1024 * 1024) throw new Error("Video exceeds desktop processing limit");
  const input = (await readFile(inputPath)).toString("base64");
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, frame?: Buffer) => {
      clearTimeout(timer);
      process.removeListener("message", reply);
      process.removeListener("disconnect", disconnected);
      if (error) reject(error);
      else resolve(frame!);
    };
    const disconnected = () => finish(new Error("Desktop decoder disconnected"));
    const reply = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const result = message as { type?: unknown; id?: unknown; frame?: unknown; error?: unknown };
      if (result.type !== "gryt:video-frame-result" || result.id !== id) return;
      if (typeof result.frame !== "string" || result.frame.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.frame)) {
        finish(new Error(typeof result.error === "string" ? result.error.slice(0, 300) : "Invalid desktop video frame"));
      } else finish(undefined, Buffer.from(result.frame, "base64"));
    };
    const timer = setTimeout(() => finish(new Error("Desktop video decoder timed out")), 15000);
    process.on("message", reply);
    process.once("disconnect", disconnected);
    process.send!({ type: "gryt:video-frame", id, input }, (error) => { if (error) finish(error); });
  });
}
