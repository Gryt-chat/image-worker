/* Runs inside the image jail: the upload on fd 3, the use as the only argument, the result on stdout.
   No storage, database or network here, so a decoder bug reaches nothing worth having. */
import { readFileSync } from "node:fs";

import { findDominantColor } from "./colour";
import { reencode, type Use } from "./reencode";
import { packResult } from "./reencodeResult";

const USES: readonly Use[] = ["upload", "banner", "avatar", "emoji"];

async function main(): Promise<void> {
  const use = process.argv[2] as Use;
  if (!USES.includes(use)) throw new Error("unknown use");
  const out = await reencode(readFileSync(3), use);
  const colour = await findDominantColor(out.body, out.animated);
  process.stdout.write(packResult(out, colour));
}

void main().catch(() => {
  process.stderr.write("re-encode failed\n");
  process.exitCode = 1;
});
