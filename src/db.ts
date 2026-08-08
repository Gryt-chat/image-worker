import consola from "consola";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) throw new Error("DB not initialized. Call initDb() first.");
  return db;
}

export function initDb(): void {
  const dataDir = process.env.DATA_DIR || "./data";
  const dbPath = join(dataDir, "gryt.db");

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);

  // node:sqlite has no pragma() helper, so these go through exec(). Same
  // statements better-sqlite3 was issuing, in the same order.
  //
  // WAL matters more here than it looks: the server holds this file open at the
  // same time, and the worker writes to it from a second process.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  consola.info(`[DB] Connected to SQLite (${dbPath})`);
}

export type ImageJobStatus = "queued" | "processing" | "done" | "error";

export interface ImageJobRecord {
  job_id: string;
  file_id: string;
  status: ImageJobStatus;
  raw_s3_key: string;
  raw_content_type: string;
  raw_bytes: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function fromIso(s: string | null | undefined): Date {
  if (!s) return new Date(0);
  return new Date(s);
}

/**
 * node:sqlite types every row as `Record<string, SQLOutputValue>`, which does
 * not structurally overlap a named interface, so TypeScript rejects a direct
 * cast to one. The queries below select exactly the columns their interface
 * names, so the conversion is sound — this keeps the one unchecked step in a
 * single place rather than repeating `as unknown as` at each call site.
 */
function rowsAs<T>(rows: Record<string, SQLOutputValue>[]): T[] {
  return rows as unknown as T[];
}

function mapRow(row: Record<string, unknown>): ImageJobRecord {
  return {
    job_id: row.job_id as string,
    file_id: row.file_id as string,
    status: row.status as ImageJobStatus,
    raw_s3_key: row.raw_s3_key as string,
    raw_content_type: row.raw_content_type as string,
    raw_bytes: (row.raw_bytes as number) || 0,
    error_message: (row.error_message as string) || null,
    created_at: fromIso(row.created_at as string),
    updated_at: fromIso(row.updated_at as string),
  };
}

export function listQueuedImageJobIds(
  limit: number,
): Array<{ job_id: string; created_at: Date }> {
  const d = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = d
    .prepare(
      "SELECT job_id, created_at FROM image_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
    )
    .all(safeLimit) as Array<{ job_id: string; created_at: string }>;
  return rows.map((r) => ({ job_id: r.job_id, created_at: fromIso(r.created_at) }));
}

export function getImageJob(jobId: string): ImageJobRecord | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM image_jobs WHERE job_id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function updateImageJobStatus(input: {
  job_id: string;
  status: ImageJobStatus;
  error_message?: string | null;
}): void {
  const d = getDb();
  const now = toIso(new Date());

  const sets: string[] = ["status = ?", "updated_at = ?"];
  const vals: SQLInputValue[] = [input.status, now];

  if (input.error_message !== undefined) {
    sets.push("error_message = ?");
    vals.push(input.error_message);
  }

  vals.push(input.job_id);
  d.prepare(`UPDATE image_jobs SET ${sets.join(", ")} WHERE job_id = ?`).run(...vals);
}

export function updateFileRecord(
  fileId: string,
  updates: {
    s3_key?: string;
    mime?: string;
    size?: number;
    thumbnail_key?: string | null;
    thumbnail_px?: number | null;
    dominant_color?: string | null;
  },
): void {
  const d = getDb();
  const sets: string[] = [];
  const vals: SQLInputValue[] = [];
  if (updates.s3_key !== undefined) {
    sets.push("s3_key = ?");
    vals.push(updates.s3_key);
  }
  if (updates.mime !== undefined) {
    sets.push("mime = ?");
    vals.push(updates.mime);
  }
  if (updates.size !== undefined) {
    sets.push("size = ?");
    vals.push(updates.size);
  }
  if (updates.thumbnail_key !== undefined) {
    sets.push("thumbnail_key = ?");
    vals.push(updates.thumbnail_key);
  }
  if (updates.thumbnail_px !== undefined) {
    sets.push("thumbnail_px = ?");
    vals.push(updates.thumbnail_px);
  }
  if (updates.dominant_color !== undefined) {
    sets.push("dominant_color = ?");
    vals.push(updates.dominant_color);
  }
  if (sets.length === 0) return;
  vals.push(fileId);
  d.prepare(`UPDATE files SET ${sets.join(", ")} WHERE file_id = ?`).run(...vals);
}

export interface ColourlessFile {
  file_id: string;
  s3_key: string;
  mime: string | null;
}

/**
 * Images that have no dominant colour yet.
 *
 * Two kinds end up here. Anything uploaded before the column existed, and
 * anything that never produces an image job at all — a user avatar goes to its
 * own /api/uploads/avatar route, which resizes inline and queues nothing, so
 * the job loop never sees one.
 *
 * Newest first: a colour is only ever looked at for a file someone is still
 * using, and on a server with years of attachments the recent end is the part
 * that pays for itself.
 */
export function listFilesMissingDominantColor(limit: number): ColourlessFile[] {
  const d = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return rowsAs<ColourlessFile>(
    d
      .prepare(
        `SELECT file_id, s3_key, mime FROM files
       WHERE dominant_color IS NULL AND mime LIKE 'image/%'
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(safeLimit),
  );
}

export interface AvatarThumb {
  file_id: string;
  s3_key: string;
  thumbnail_key: string;
  mime: string | null;
}

/**
 * The avatar thumbnail size this server writes, as the server itself reports it.
 *
 * Read rather than hardcoded. There is no package shared with the server, and
 * the same constant written down in both repositories and kept in step by hand
 * is a coupling that fails quietly: too low and the rebuild pass never runs, too
 * high and it rebuilds every avatar on every start, forever. The server writes
 * this on each of its own starts, so it is whatever that build actually uses.
 *
 * Null on a server older than the column. Nothing to rebuild towards, so the
 * caller does nothing — which is the right answer, not a fallback guess.
 */
export function getAvatarThumbPx(): number | null {
  const d = getDb();
  try {
    const row = d
      .prepare("SELECT avatar_thumb_px FROM server_config WHERE id = 'config'")
      .get() as { avatar_thumb_px: number | null } | undefined;
    if (!row || row.avatar_thumb_px == null) return null;
    const n = Number(row.avatar_thumb_px);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

/**
 * Avatars whose thumbnail is smaller than the one this server writes today.
 *
 * `thumbnail_px` says how big each one is, so the query decides rather than the
 * caller decoding every thumbnail to find out. Null means it was made before
 * the column existed and its size is unknown, which is treated as "rebuild" —
 * those are exactly the 64px ones this pass is for.
 *
 * Keyed off the s3_key prefix because "is this an avatar" is not otherwise
 * recorded. Chat attachments have thumbnails too and are left alone; their size
 * was never the problem.
 */
export function listUndersizedAvatarThumbnails(
  targetPx: number,
  limit: number,
): AvatarThumb[] {
  const d = getDb();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return rowsAs<AvatarThumb>(
    d
      .prepare(
        `SELECT file_id, s3_key, thumbnail_key, mime FROM files
       WHERE thumbnail_key IS NOT NULL AND s3_key LIKE 'avatars/%'
         AND (thumbnail_px IS NULL OR thumbnail_px < ?)
       ORDER BY created_at DESC LIMIT ?`,
      )
      .all(targetPx, safeLimit),
  );
}

const DEFAULT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export function getUploadMaxBytes(): number {
  const d = getDb();
  const row = d
    .prepare("SELECT upload_max_bytes FROM server_config WHERE id = 'config'")
    .get() as { upload_max_bytes: number | null } | undefined;
  if (!row || row.upload_max_bytes == null) return DEFAULT_UPLOAD_MAX_BYTES;
  return row.upload_max_bytes;
}
