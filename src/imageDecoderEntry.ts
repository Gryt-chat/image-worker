import { readFileSync } from "node:fs";
import { reconstructImage, reconstructPoster } from "./reconstructImage";

async function main() {
  const maxBytes = Number(process.argv[2]);
  const thumbWidth = Number(process.argv[4]);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(thumbWidth) || thumbWidth < 1 || thumbWidth > 1024
    || !["banner", "image", "avatar-thumb", "poster"].includes(process.argv[3])) throw new Error("Invalid decoder request");
  const bytes = readFileSync(3);
  const result = process.argv[3] === "poster" ? await reconstructPoster(bytes)
    : await reconstructImage(bytes, maxBytes, process.argv[3] === "banner", thumbWidth, process.argv[3] === "avatar-thumb");
  const header = Buffer.from(JSON.stringify({ bodyBytes: result.body.length, thumbBytes: result.thumb.length, dominantColor: result.dominantColor, animated: result.animated }));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  process.stdout.write(Buffer.concat([size, header, result.body, result.thumb]));
}

void main().catch(() => { process.stderr.write("Image reconstruction failed\n"); process.exitCode = 1; });
