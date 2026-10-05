/* Re-encodes inside the image jail when the worker has one (the Docker image always does). Without
   it, production refuses and the file stays in quarantine; a dev machine re-encodes in process. */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findDominantColor } from "./colour";
import { hasDesktopSandbox, reencodeOnDesktop } from "./desktopSandbox";
import { reencode, type Use } from "./reencode";
import { type JailResult, unpackResult } from "./reencodeResult";
import { findExecutable, JAIL_FAILED, run } from "./videoPoster";

const JAIL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const JAIL_TIMEOUT_MS = 60_000;
/* Under the jail's own path, so it reads the same inside and out. */
const ENTRY = "/decoder/dist/reencodeEntry.js";

export async function reencodeInJail(
  bytes: Buffer,
  use: Use,
  socket = process.env.IMAGEJAIL_SOCKET,
  production = process.env.NODE_ENV === "production",
): Promise<JailResult> {
  if (!socket) {
    if (hasDesktopSandbox()) return reencodeOnDesktop(bytes, use);
    if (production) throw new Error("No image jail, so the upload stays in quarantine");
    const out = await reencode(bytes, use);
    return { ...out, dominantColor: await findDominantColor(out.body, out.animated), thumbMime: "image/avif" };
  }
  const client = findExecutable("ffjail");
  if (!client || !existsSync(socket)) throw new Error("The image jail isn't running, so the upload stays in quarantine");

  const dir = await mkdtemp(join(tmpdir(), "gryt-reencode-"));
  try {
    const input = join(dir, "input");
    await writeFile(input, bytes, { mode: 0o600, flag: "wx" });
    const argv = ["run", socket, String(JAIL_MEMORY_BYTES), String(JAIL_TIMEOUT_MS), "--",
      "--jitless", "--max-old-space-size=512", "--disable-wasm-trap-handler", ENTRY, use];
    const result = await run(client, argv, input, JAIL_TIMEOUT_MS + 5_000);
    if (result.timedOut) throw new Error("The image jail ran out of time");
    if (result.tooBig) throw new Error("The image jail's answer was over the size cap");
    if (result.code === JAIL_FAILED) throw new Error(`The image jail could not start the decoder: ${result.stderr.trim().slice(0, 200)}`);
    if (result.code !== 0) throw new Error("The upload could not be decoded");
    return unpackResult(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
