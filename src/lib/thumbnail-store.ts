/**
 * Thumbnail storage for the picture-check pack.
 *
 * Frames are written to a data directory (default `<cwd>/data/thumbnails`,
 * override with MACATTACK_DATA_DIR) rather than the database, so polling and
 * exports stay small. Names are generated server-side and validated on read,
 * which blocks path traversal.
 *
 * Where those files land on the host's harddisk is decided by docker-compose:
 * the bundled compose file bind-mounts `./data` (next to docker-compose.yml)
 * at `/app/data`, so captures appear in `./data/thumbnails` on the host —
 * e.g. `mac-attack\data\thumbnails` over a Windows/SMB share. A Docker
 * *named volume* at /app/data would instead hide them in Docker's own
 * storage, invisible in any host folder.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const FALLBACK_DIR = path.join(process.env.TMPDIR || "/tmp", "macattack-thumbnails");

/** Diagnostics for the last write attempt, surfaced in the scan log/UI. */
let lastWriteDir: string | null = null;
let lastStoreError: string | null = null;
let usingFallbackDir = false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Numeric uid/gid of this process (null on platforms without them, e.g.
 * native Windows). This is THE id a bind-mounted data directory must be
 * writable by. It is not always 1001: the image's default user (`nextjs`)
 * is 1001:1001, but the bundled docker-compose.yml overrides the container
 * user to `${PUID:-1026}:${PGID:-100}`. Every user-facing message must use
 * these live values — the old hardcoded "uid 1001" sent operators to chown
 * the host folder to an id the container was not even running as.
 */
export function runtimeUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

export function runtimeGid(): number | null {
  return typeof process.getgid === "function" ? process.getgid() : null;
}

/** "uid 1026:100" style description of the app user, for logs and the UI. */
export function describeRuntimeUser(): string {
  const uid = runtimeUid();
  const gid = runtimeGid();
  if (uid === null) return "the app user";
  return gid === null ? `the app user (uid ${uid})` : `the app user (uid ${uid}:${gid})`;
}

// Serialize writes and resets. A capture begun before a new search must never
// repopulate the cache after that search has cleared it.
let generation = 0;
let mutationQueue: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

export function thumbnailGeneration(): number {
  return generation;
}

/** Clear only our JPEG cache, never the configured data directory itself. */
export function clearThumbnails(): Promise<number> {
  generation += 1;
  return mutate(async () => {
    let removed = 0;
    for (const dir of new Set([thumbnailsDir(), FALLBACK_DIR])) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !isSafeName(entry.name)) continue;
        await fs.unlink(path.join(dir, entry.name));
        removed += 1;
      }
    }
    lastWriteDir = null;
    lastStoreError = null;
    usingFallbackDir = false;
    return removed;
  });
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

/**
 * Prove a directory is writable by actually creating and deleting a probe
 * file in it; returns null when writable, else the failure reason.
 *
 * `mkdir -p` plus `access(W_OK)` (the old check) is not proof: mkdir succeeds
 * when the directory already exists even if it is read-only for this uid, and
 * access() goes by mode bits, which Synology shared-folder ACLs, NFS
 * root-squash and read-only mounts can all contradict. A real create+unlink
 * is the only answer that matches what saveThumbnail will experience. The
 * probe name is not a `.jpg`, so clear/prune/count logic ignores it.
 */
async function probeWritable(dir: string): Promise<string | null> {
  const probe = path.join(dir, `.macattack-write-test-${process.pid}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "");
    return null;
  } catch (error) {
    return `cannot write to ${dir} as ${describeRuntimeUser()} (${describeError(error)})`;
  } finally {
    await fs.unlink(probe).catch(() => undefined);
  }
}

export async function ensureThumbnailDir(): Promise<string> {
  const dir = thumbnailsDir();
  const error = await probeWritable(dir);
  if (error === null) {
    usingFallbackDir = false;
    lastStoreError = null;
    return dir;
  }
  // A bind mount owned by another UID (e.g. Docker auto-created ./data as
  // root, or a host folder owned by a different NAS user) cannot be written
  // by the app user. Keep the fallback so thumbnails still work, but remember
  // why so the scan log and the Host capabilities panel can say where the
  // files actually went instead of leaving an empty directory.
  lastStoreError = error;
  usingFallbackDir = true;
  await fs.mkdir(FALLBACK_DIR, { recursive: true });
  return FALLBACK_DIR;
}

/** Store a JPEG and return its file name (not a path). */
export function saveThumbnail(key: string, jpeg: Buffer, expectedGeneration = generation): Promise<string | null> {
  return mutate(async () => {
    if (expectedGeneration !== generation) return null;
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const name = `${safeKey}-${Date.now()}.jpg`;
    // mkdir can succeed for an existing read-only mount. Retry the actual
    // write in the fallback too, not just directory creation.
    for (const dir of [thumbnailsDir(), FALLBACK_DIR]) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, name), jpeg);
        lastWriteDir = dir;
        usingFallbackDir = dir === FALLBACK_DIR;
        if (!usingFallbackDir) lastStoreError = null;
        return name;
      } catch (error) {
        const detail = `cannot write to ${dir} (${describeError(error)})`;
        lastStoreError = dir === FALLBACK_DIR && lastStoreError
          ? `${lastStoreError}; ${detail}`
          : detail;
      }
    }
    return null;
  });
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

async function countJpegs(dir: string): Promise<number> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith(".jpg")).length;
  } catch {
    return 0; // directory not created yet — nothing stored
  }
}

/**
 * Where thumbnails live and how many are stored (for the system panel).
 *
 * `writable` is proven with a real create+unlink probe in the configured
 * directory (see probeWritable), so a host folder owned by a different UID
 * than the container user shows up here as `writable: false` — with the
 * actual `uid`/`gid` to chown it to — instead of a silent "0 files".
 *
 * `fileCount` counts the configured directory (the host-visible
 * `./data/thumbnails` bind mount in the bundled compose setup);
 * `fallbackFileCount` counts the container-local fallback, and
 * `effectiveDir` says which of the two new captures are really written to.
 */
export async function thumbnailStoreInfo(): Promise<{
  dir: string;
  fallbackDir: string;
  /** Directory new thumbnails are actually written to: `dir`, or `fallbackDir` when using the fallback. */
  effectiveDir: string;
  fileCount: number;
  fallbackFileCount: number;
  maxAgeDays: number;
  writable: boolean;
  usingFallback: boolean;
  lastError: string | null;
  /** uid/gid of the app process; the data directory must be writable by these (null where unsupported). */
  uid: number | null;
  gid: number | null;
}> {
  const dir = thumbnailsDir();
  const probeError = await probeWritable(dir);
  const writable = probeError === null;
  if (!writable && probeError) lastStoreError = probeError;
  // Keep a recorded save-fallback sticky: files already written went to the
  // fallback even if a probe right now would succeed. A later successful
  // save (or clearThumbnails) is what resets it.
  const usingFallback = usingFallbackDir || !writable;
  return {
    dir,
    fallbackDir: FALLBACK_DIR,
    effectiveDir: usingFallback ? FALLBACK_DIR : dir,
    fileCount: await countJpegs(dir),
    fallbackFileCount: await countJpegs(FALLBACK_DIR),
    maxAgeDays: 14,
    writable,
    usingFallback,
    lastError: lastStoreError,
    uid: runtimeUid(),
    gid: runtimeGid(),
  };
}
