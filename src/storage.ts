import { constants, existsSync } from "fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";

interface StorageBackend {
  getObjectAsBuffer(bucket: string, key: string): Promise<Buffer>;
  getObjectToFile(bucket: string, key: string, dest: string): Promise<void>;
  putObject(bucket: string, key: string, body: Buffer, contentType?: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
}

// ── Filesystem backend ──────────────────────────────────────────────────────

let fsDataDir: string | null = null;

function resolvePath(bucket: string, key: string): string {
  if (!fsDataDir) throw new Error("Filesystem storage not initialized");
  return join(fsDataDir, bucket, key);
}

const fsBackend: StorageBackend = {
  async getObjectAsBuffer(bucket, key) {
    const filePath = resolvePath(bucket, key);
    if (!existsSync(filePath)) {
      const err = new Error(`Object not found: ${key}`);
      (err as NodeJS.ErrnoException).code = "NoSuchKey";
      throw err;
    }
    return readFile(filePath);
  },

  async getObjectToFile(bucket, key, dest) {
    await copyFile(resolvePath(bucket, key), dest, constants.COPYFILE_EXCL);
  },

  async putObject(bucket, key, body, contentType) {
    const filePath = resolvePath(bucket, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    if (contentType) {
      await writeFile(filePath + ".meta", JSON.stringify({ contentType }));
    }
  },

  async deleteObject(bucket, key) {
    const filePath = resolvePath(bucket, key);
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await unlink(filePath + ".meta");
    } catch {
      /* meta file may not exist */
    }
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

let backend: StorageBackend | null = null;

function getBackend(): StorageBackend {
  if (!backend) throw new Error("Storage not initialized. Call initStorage() first.");
  return backend;
}

/** Disk only. The server copies an old S3 bucket into the same folder on its first start. */
export async function initStorage(): Promise<void> {
  const named = (process.env.STORAGE_BACKEND || "").trim().toLowerCase();
  if ((named && named !== "filesystem") || (process.env.S3_ENDPOINT || "").trim()) {
    console.warn("S3 settings are set but ignored: uploads are read from and written to DATA_DIR.");
  }
  fsDataDir = process.env.DATA_DIR || "./data";
  // The server defaults to the same folder, so a compose file can leave both unset.
  if (!(process.env.S3_BUCKET || "").trim()) process.env.S3_BUCKET = "gryt";
  backend = fsBackend;
}

export function getObjectAsBuffer(bucket: string, key: string): Promise<Buffer> {
  return getBackend().getObjectAsBuffer(bucket, key);
}

/** Streams to disk, so a video never has to fit in memory. */
export function getObjectToFile(bucket: string, key: string, dest: string): Promise<void> {
  return getBackend().getObjectToFile(bucket, key, dest);
}

export function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  return getBackend().putObject(bucket, key, body, contentType);
}

export function deleteObject(bucket: string, key: string): Promise<void> {
  return getBackend().deleteObject(bucket, key);
}
