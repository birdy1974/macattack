/**
 * Thumbnail storage for the picture-check pack.
 *
 * Frames are written to a data directory (default `<cwd>/data/thumbnails`,
 * override with MACATTACK_DATA_DIR) rather than the database, so polling and
 * exports stay small. Names are generated server-side and validated on read,
 * which blocks path traversal.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const FALLBACK_DIR = path.join(process.env.TMPDIR || "/tmp", "macattack-thumbnails");

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
    return dir;
  } catch {
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
    return name;
  } catch {
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

/** Where thumbnails live and how many are stored (for the system panel). */
export async function thumbnailStoreInfo(): Promise<{ dir: string; fileCount: number | null; maxAgeDays: number }> {
  let fileCount: number | null = null;
  try {
    const dir = thumbnailsDir();
    const names = await fs.readdir(dir);
    fileCount = names.filter((name) => name.endsWith(".jpg")).length;
  } catch {
    fileCount = 0; // directory not created yet — nothing stored
  }
  return { dir: thumbnailsDir(), fileCount, maxAgeDays: 14 };
}
