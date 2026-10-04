/**
 * Thumbnail storage for the picture-check pack.
 *
 * Frames are written to a data directory (default `<cwd>/data/thumbnails`,
 * override with MACATTACK_DATA_DIR) rather than the database, so polling and
 * exports stay small. Names are generated server-side and validated on read,
 * which blocks path traversal.
 */

import { constants, promises as fs } from "node:fs";
import path from "node:path";

const FALLBACK_DIR = path.join(process.env.TMPDIR || "/tmp", "macattack-thumbnails");

/** Diagnostics for the last write attempt, surfaced in the scan log/UI. */
let lastWriteDir: string | null = null;
let lastStoreError: string | null = null;
let usingFallbackDir = false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Directory the most recent successful save went into. */
export function lastThumbnailWriteDir(): string | null {
  return lastWriteDir;
}

/** Why the configured thumbnail directory could not be used (null = fine). */
export function thumbnailStoreError(): string | null {
  return lastStoreError;
}

export function thumbnailsDir(): string {
  const base = process.env.MACATTACK_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(base, "thumbnails");
}

function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.jpg$/.test(name) && !name.includes("..");
}

export async function ensureThumbnailDir(): Promise<string> {
  const dir = thumbnailsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    usingFallbackDir = false;
    return dir;
  } catch (error) {
    // A bind mount owned by another UID (the container runs as uid 1001) cannot
    // be created/written by the app user. Keep the fallback so thumbnails still
    // work, but remember why so the scan log and the Host capabilities panel can
    // say where the files actually went instead of leaving an empty directory.
    lastStoreError = `cannot write to ${dir} (${describeError(error)})`;
    usingFallbackDir = true;
    await fs.mkdir(FALLBACK_DIR, { recursive: true });
    return FALLBACK_DIR;
  }
}

/** Store a JPEG and return its file name (not a path). */
export async function saveThumbnail(key: string, jpeg: Buffer): Promise<string | null> {
  try {
    const dir = await ensureThumbnailDir();
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const name = `${safeKey}-${Date.now()}.jpg`;
    await fs.writeFile(path.join(dir, name), jpeg);
    lastWriteDir = dir;
    usingFallbackDir = dir === FALLBACK_DIR;
    return name;
  } catch (error) {
    lastStoreError = `could not write ${key} (${describeError(error)})`;
    return null;
  }
}

export async function readThumbnail(name: string): Promise<Buffer | null> {
  if (!isSafeName(name)) return null;
  const candidates = [path.join(thumbnailsDir(), name), path.join(FALLBACK_DIR, name)];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export async function deleteThumbnail(name: string): Promise<void> {
  if (!isSafeName(name)) return;
  for (const candidate of [path.join(thumbnailsDir(), name), path.join(FALLBACK_DIR, name)]) {
    try {
      await fs.unlink(candidate);
    } catch {
      /* ignore */
    }
  }
}

/** Delete thumbnails older than `maxAgeMs` (called opportunistically by the scanner). */
export async function pruneThumbnails(maxAgeMs = 14 * 24 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of [thumbnailsDir(), FALLBACK_DIR]) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!isSafeName(entry)) continue;
        const full = path.join(dir, entry);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(full);
            removed += 1;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* directory missing: nothing to prune */
    }
  }
  return removed;
}

/**
 * Where thumbnails live and how many are stored (for the system panel).
 *
 * `writable` reports whether the app user can actually create the directory
 * and write into it. A bind mount owned by another UID (the container runs as
 * uid 1001) shows up here as `writable: false` instead of a silent "0 files".
 */
export async function thumbnailStoreInfo(): Promise<{
  dir: string;
  fallbackDir: string;
  fileCount: number | null;
  maxAgeDays: number;
  writable: boolean;
  usingFallback: boolean;
  lastError: string | null;
}> {
  const dir = thumbnailsDir();
  let fileCount: number | null = null;
  let writable = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, constants.W_OK);
    writable = true;
    const names = await fs.readdir(dir);
    fileCount = names.filter((name) => name.endsWith(".jpg")).length;
  } catch {
    fileCount = 0; // directory not created yet — nothing stored
    writable = false;
  }
  return {
    dir,
    fallbackDir: FALLBACK_DIR,
    fileCount,
    maxAgeDays: 14,
    writable,
    usingFallback: usingFallbackDir || !writable,
    lastError: lastStoreError,
  };
}
